import Foundation
import CoreLocation
import SwiftData
import UIKit

/// Pilote une session de capture pour une séquence.
///
/// Règle du mode auto (mix temps + position) : toutes les `interval` secondes, une photo
/// n'est prise que si l'on s'est déplacé d'au moins `minDistance` mètres depuis la
/// précédente et que la précision GPS est suffisante. À l'arrêt, rien n'est pris.
@MainActor
@Observable
final class CaptureController {
    let camera = CameraService()
    let location = LocationService()
    let sequence: PhotoSequence

    private(set) var isAuto = false
    private(set) var isCapturing = false
    private(set) var message: String?
    private(set) var shotCount = 0

    private var timer: Timer?
    private var lastShotLocation: CLLocation?

    init(sequence: PhotoSequence) {
        self.sequence = sequence
        self.lastShotLocation = sequence.sortedPhotos.last.map {
            CLLocation(latitude: $0.latitude, longitude: $0.longitude)
        }
    }

    func start() {
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()
        location.start()
        Task { await camera.start() }
    }

    func stop() {
        stopAuto()
        camera.stop()
        location.stop()
        UIDevice.current.endGeneratingDeviceOrientationNotifications()
    }

    // MARK: Mode auto

    func toggleAuto() {
        isAuto ? stopAuto() : startAuto()
    }

    private func startAuto() {
        isAuto = true
        message = nil
        timer = Timer.scheduledTimer(withTimeInterval: AppSettings.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        tick()
    }

    private func stopAuto() {
        isAuto = false
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard isAuto, !isCapturing, let loc = usableLocation() else { return }
        if let last = lastShotLocation, loc.distance(from: last) < AppSettings.minDistance {
            return // immobile ou presque : pas de nouvelle photo
        }
        Task { await take(at: loc) }
    }

    // MARK: Déclencheur manuel

    func manualShot() {
        guard !isCapturing else { return }
        guard let loc = usableLocation() else {
            message = "Position GPS pas encore assez précise."
            return
        }
        Task { await take(at: loc) }
    }

    // MARK: État GPS

    enum GPSQuality { case none, poor, ok, good }

    var gpsQuality: GPSQuality {
        guard let loc = location.location, loc.horizontalAccuracy >= 0 else { return .none }
        if loc.horizontalAccuracy <= 10 { return .good }
        if loc.horizontalAccuracy <= AppSettings.maxAccuracy { return .ok }
        return .poor
    }

    /// Position récente et assez précise, sinon nil.
    private func usableLocation() -> CLLocation? {
        guard let loc = location.location,
              loc.horizontalAccuracy >= 0,
              loc.horizontalAccuracy <= AppSettings.maxAccuracy,
              abs(loc.timestamp.timeIntervalSinceNow) < 10 else { return nil }
        return loc
    }

    // MARK: Prise de vue

    private func take(at loc: CLLocation) async {
        isCapturing = true
        defer { isCapturing = false }

        let orientation = UIDevice.current.orientation
        location.updateHeadingOrientation(orientation)
        let date = Date()
        let info = ExifWriter.Info(location: loc, heading: location.bestHeading, date: date)

        do {
            let data = try await camera.capture(info: info, rotationAngle: CameraService.rotationAngle(for: orientation))
            let fileName = Self.fileName(for: date)
            try data.write(to: sequence.directory.appendingPathComponent(fileName), options: .atomic)

            let photo = CapturedPhoto(fileName: fileName, location: loc, heading: info.heading, capturedAt: date)
            photo.sequence = sequence
            sequence.modelContext?.insert(photo)
            try? sequence.modelContext?.save()

            lastShotLocation = loc
            shotCount += 1
            message = nil
        } catch {
            message = error.localizedDescription
        }
    }

    private static func fileName(for date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyyMMdd_HHmmss_SSS"
        return "IMG_\(f.string(from: date)).jpg"
    }
}
