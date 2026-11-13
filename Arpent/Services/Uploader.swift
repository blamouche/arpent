import Foundation
import SwiftData

/// Envoi des séquences sur Panoramax, reprenable : chaque photo garde un drapeau `uploaded`
/// et la séquence garde son `uploadSetId`, donc une reprise n'envoie que ce qui manque.
@MainActor
@Observable
final class Uploader {
    /// Avancement par séquence (0...1) pendant l'envoi.
    private(set) var progress: [UUID: Double] = [:]
    var errorMessage: String?

    func isUploading(_ sequence: PhotoSequence) -> Bool {
        progress[sequence.id] != nil
    }

    var isBusy: Bool { !progress.isEmpty }

    func upload(_ sequences: [PhotoSequence], auth: AuthService) async {
        for sequence in sequences where sequence.pendingCount > 0 {
            guard await upload(sequence, auth: auth) else { break }
        }
    }

    /// Renvoie false si l'envoi a échoué.
    @discardableResult
    func upload(_ sequence: PhotoSequence, auth: AuthService) async -> Bool {
        guard !isUploading(sequence), sequence.pendingCount > 0 else { return true }
        guard let base = AppSettings.instanceURL, let token = auth.token else {
            errorMessage = PanoramaxClient.APIError.notLoggedIn.localizedDescription
            return false
        }
        let client = PanoramaxClient(baseURL: base, token: token)
        let context = sequence.modelContext
        progress[sequence.id] = 0
        defer { progress[sequence.id] = nil }

        do {
            try await send(sequence, with: client, base: base, context: context)
        } catch let error as PanoramaxClient.APIError where error.statusCode == 404 {
            // Upload set supprimé côté serveur : on repart d'un nouveau.
            sequence.uploadSetId = nil
            do {
                try await send(sequence, with: client, base: base, context: context)
            } catch {
                errorMessage = error.localizedDescription
                return false
            }
        } catch {
            errorMessage = error.localizedDescription
            return false
        }

        if AppSettings.deleteAfterUpload {
            Storage.deleteFiles(of: sequence)
        }
        return true
    }

    private func send(_ sequence: PhotoSequence, with client: PanoramaxClient, base: URL, context: ModelContext?) async throws {
        let pending = sequence.sortedPhotos.filter { !$0.uploaded }

        // Nouvel upload set si aucun, si l'instance a changé ou si le précédent est déjà terminé.
        if sequence.uploadSetId == nil || sequence.uploadInstance != base.absoluteString || sequence.uploadCompleted {
            let set = try await client.createUploadSet(title: sequence.name, estimatedFiles: pending.count)
            sequence.uploadSetId = set.id
            sequence.uploadInstance = base.absoluteString
            sequence.uploadCompleted = false
            try? context?.save()
        }
        guard let setId = sequence.uploadSetId else { return }

        for (index, photo) in pending.enumerated() {
            guard let fileURL = photo.fileURL else { continue }
            try await client.uploadFile(uploadSetId: setId, fileURL: fileURL, fileName: photo.fileName)
            photo.uploaded = true
            try? context?.save()
            progress[sequence.id] = Double(index + 1) / Double(pending.count)
        }

        try await client.completeUploadSet(setId)
        sequence.uploadCompleted = true
        try? context?.save()
    }
}
