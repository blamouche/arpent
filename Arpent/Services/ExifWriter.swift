import Foundation
import CoreLocation
import ImageIO

/// Construit les métadonnées EXIF/GPS lues par Panoramax :
/// position, altitude, précision, direction, vitesse, date de prise de vue avec millisecondes.
enum ExifWriter {
    struct Info {
        let location: CLLocation
        let heading: Double?
        let date: Date
    }

    /// Fusionne les métadonnées GPS/date dans un dictionnaire de métadonnées existant (clés ImageIO).
    static func merge(_ base: [String: Any], with info: Info) -> [String: Any] {
        var meta = base

        var exif = meta[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        exif[kCGImagePropertyExifDateTimeOriginal as String] = localFormatter("yyyy:MM:dd HH:mm:ss").string(from: info.date)
        exif[kCGImagePropertyExifDateTimeDigitized as String] = localFormatter("yyyy:MM:dd HH:mm:ss").string(from: info.date)
        exif[kCGImagePropertyExifSubsecTimeOriginal as String] = localFormatter("SSS").string(from: info.date)
        exif[kCGImagePropertyExifSubsecTimeDigitized as String] = localFormatter("SSS").string(from: info.date)
        exif[kCGImagePropertyExifOffsetTimeOriginal as String] = localFormatter("xxx").string(from: info.date)
        meta[kCGImagePropertyExifDictionary as String] = exif

        meta[kCGImagePropertyGPSDictionary as String] = gpsDictionary(info)
        return meta
    }

    static func gpsDictionary(_ info: Info) -> [String: Any] {
        let loc = info.location
        let c = loc.coordinate
        var gps: [String: Any] = [
            kCGImagePropertyGPSVersion as String: [2, 3, 0, 0],
            kCGImagePropertyGPSLatitude as String: abs(c.latitude),
            kCGImagePropertyGPSLatitudeRef as String: c.latitude >= 0 ? "N" : "S",
            kCGImagePropertyGPSLongitude as String: abs(c.longitude),
            kCGImagePropertyGPSLongitudeRef as String: c.longitude >= 0 ? "E" : "W",
            kCGImagePropertyGPSDateStamp as String: utcFormatter("yyyy:MM:dd").string(from: info.date),
            kCGImagePropertyGPSTimeStamp as String: utcFormatter("HH:mm:ss.SSS").string(from: info.date),
        ]
        if loc.horizontalAccuracy >= 0 {
            gps[kCGImagePropertyGPSHPositioningError as String] = loc.horizontalAccuracy
        }
        if loc.verticalAccuracy >= 0 {
            gps[kCGImagePropertyGPSAltitude as String] = abs(loc.altitude)
            gps[kCGImagePropertyGPSAltitudeRef as String] = loc.altitude >= 0 ? 0 : 1
        }
        if let h = info.heading {
            gps[kCGImagePropertyGPSImgDirection as String] = h
            gps[kCGImagePropertyGPSImgDirectionRef as String] = "T"
        }
        if loc.speed >= 0 {
            gps[kCGImagePropertyGPSSpeed as String] = loc.speed * 3.6
            gps[kCGImagePropertyGPSSpeedRef as String] = "K"
        }
        if loc.course >= 0 {
            gps[kCGImagePropertyGPSTrack as String] = loc.course
            gps[kCGImagePropertyGPSTrackRef as String] = "T"
        }
        return gps
    }

    /// Réécrit un JPEG complet avec les métadonnées (utilisé pour l'image de repli du simulateur).
    static func write(jpeg data: Data, info: Info) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let type = CGImageSourceGetType(source) else { return nil }
        let base = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] ?? [:]
        var props = merge(base, with: info)
        props[kCGImageDestinationLossyCompressionQuality as String] = 0.9
        let output = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(output, type, 1, nil) else { return nil }
        CGImageDestinationAddImageFromSource(dest, source, 0, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return output as Data
    }

    private static func localFormatter(_ format: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = format
        return f
    }

    private static func utcFormatter(_ format: String) -> DateFormatter {
        let f = localFormatter(format)
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }
}
