import Foundation
import SwiftData

/// Une séquence = une suite de photos prises d'affilée, envoyée comme un « upload set » Panoramax.
@Model
final class PhotoSequence {
    var id: UUID
    var name: String
    var createdAt: Date
    /// Identifiant de l'upload set Panoramax en cours (nil tant que rien n'a été envoyé).
    var uploadSetId: String?
    /// Instance sur laquelle l'upload set a été créé.
    var uploadInstance: String?
    /// true une fois `/complete` appelé : de nouvelles photos nécessiteront un nouvel upload set.
    var uploadCompleted: Bool = false

    @Relationship(deleteRule: .cascade, inverse: \CapturedPhoto.sequence)
    var photos: [CapturedPhoto] = []

    init(name: String) {
        self.id = UUID()
        self.name = name
        self.createdAt = .now
    }

    var sortedPhotos: [CapturedPhoto] {
        photos.sorted { $0.capturedAt < $1.capturedAt }
    }

    var uploadedCount: Int { photos.filter(\.uploaded).count }
    var pendingCount: Int { photos.count - uploadedCount }
    var isFullyUploaded: Bool { !photos.isEmpty && pendingCount == 0 }

    var directory: URL { Storage.directory(for: id) }

    static func defaultName(for date: Date = .now) -> String {
        "Séquence du " + date.formatted(date: .abbreviated, time: .shortened)
    }
}
