import Foundation
import SwiftData
import CoreLocation

/// Une photo de la séquence. Le JPEG (avec EXIF GPS) est stocké sur disque, seules les métadonnées sont en base.
@Model
final class CapturedPhoto {
    var id: UUID
    var fileName: String
    var latitude: Double
    var longitude: Double
    var altitude: Double
    var horizontalAccuracy: Double
    var heading: Double?
    var capturedAt: Date
    var uploaded: Bool = false
    var rejectedReason: String?
    var sequence: PhotoSequence?

    init(fileName: String, location: CLLocation, heading: Double?, capturedAt: Date) {
        self.id = UUID()
        self.fileName = fileName
        self.latitude = location.coordinate.latitude
        self.longitude = location.coordinate.longitude
        self.altitude = location.altitude
        self.horizontalAccuracy = location.horizontalAccuracy
        self.heading = heading
        self.capturedAt = capturedAt
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    var fileURL: URL? {
        sequence?.directory.appendingPathComponent(fileName)
    }
}
