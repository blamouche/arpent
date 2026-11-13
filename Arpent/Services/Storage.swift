import Foundation
import SwiftData

/// Emplacement des JPEG : Application Support/Sequences/<id séquence>/
enum Storage {
    static var root: URL {
        URL.applicationSupportDirectory.appending(path: "Sequences", directoryHint: .isDirectory)
    }

    static func directory(for sequenceId: UUID) -> URL {
        let dir = root.appending(path: sequenceId.uuidString, directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Supprime une séquence et ses fichiers.
    static func delete(_ sequence: PhotoSequence, in context: ModelContext) {
        try? FileManager.default.removeItem(at: sequence.directory)
        context.delete(sequence)
        try? context.save()
    }

    /// Libère l'espace : supprime les JPEG mais garde l'historique (carte, statut).
    static func deleteFiles(of sequence: PhotoSequence) {
        for photo in sequence.photos where photo.uploaded {
            if let url = photo.fileURL { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// Supprime une photo et son fichier.
    static func delete(_ photo: CapturedPhoto, in context: ModelContext) {
        if let url = photo.fileURL { try? FileManager.default.removeItem(at: url) }
        context.delete(photo)
        try? context.save()
    }
}
