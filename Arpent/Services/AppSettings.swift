import Foundation

/// Réglages utilisateur (UserDefaults). Les vues utilisent @AppStorage avec les mêmes clés.
enum AppSettings {
    static let instanceURLKey = "instanceURL"
    static let intervalKey = "captureInterval"
    static let minDistanceKey = "minDistance"
    static let maxAccuracyKey = "maxAccuracy"
    static let deleteAfterUploadKey = "deleteAfterUpload"

    static let defaultInstance = "https://panoramax.openstreetmap.fr"
    static let defaultInterval = 2.0       // secondes
    static let defaultMinDistance = 4.0    // mètres
    static let defaultMaxAccuracy = 20.0   // mètres

    static func registerDefaults() {
        UserDefaults.standard.register(defaults: [
            instanceURLKey: defaultInstance,
            intervalKey: defaultInterval,
            minDistanceKey: defaultMinDistance,
            maxAccuracyKey: defaultMaxAccuracy,
            deleteAfterUploadKey: false,
        ])
    }

    private static var defaults: UserDefaults { .standard }

    /// URL de l'instance normalisée (https par défaut, sans slash final).
    static var instanceURL: URL? { normalize(defaults.string(forKey: instanceURLKey) ?? defaultInstance) }

    static var interval: Double { max(0.5, defaults.double(forKey: intervalKey)) }
    static var minDistance: Double { max(0, defaults.double(forKey: minDistanceKey)) }
    static var maxAccuracy: Double { max(1, defaults.double(forKey: maxAccuracyKey)) }
    static var deleteAfterUpload: Bool { defaults.bool(forKey: deleteAfterUploadKey) }

    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.lowercased().hasPrefix("http") { s = "https://" + s }
        while s.hasSuffix("/") { s.removeLast() }
        return URL(string: s)
    }
}
