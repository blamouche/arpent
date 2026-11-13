import Foundation
import CoreLocation
import UIKit

/// Position GPS et cap de l'appareil, en continu pendant la capture.
@Observable
final class LocationService: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    private(set) var location: CLLocation?
    private(set) var heading: CLHeading?
    private(set) var authorization: CLAuthorizationStatus

    override init() {
        authorization = manager.authorizationStatus
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .fitness
        manager.headingFilter = 1
    }

    func start() {
        if manager.authorizationStatus == .notDetermined {
            manager.requestWhenInUseAuthorization()
        }
        manager.startUpdatingLocation()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
    }

    var isDenied: Bool {
        authorization == .denied || authorization == .restricted
    }

    /// Direction de prise de vue en degrés (0 = nord), ou nil si inconnue.
    /// Cap boussole si disponible, sinon direction du déplacement.
    var bestHeading: Double? {
        if let h = heading, h.headingAccuracy >= 0 {
            return h.trueHeading >= 0 ? h.trueHeading : h.magneticHeading
        }
        if let loc = location, loc.course >= 0, loc.speed > 0.5 {
            return loc.course
        }
        return nil
    }

    /// Aligne le calcul du cap sur l'orientation physique du téléphone (portrait / paysage).
    func updateHeadingOrientation(_ orientation: UIDeviceOrientation) {
        let mapped: CLDeviceOrientation
        switch orientation {
        case .landscapeLeft: mapped = .landscapeLeft
        case .landscapeRight: mapped = .landscapeRight
        case .portraitUpsideDown: mapped = .portraitUpsideDown
        default: mapped = .portrait
        }
        if manager.headingOrientation != mapped {
            manager.headingOrientation = mapped
        }
    }

    // MARK: CLLocationManagerDelegate

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        authorization = manager.authorizationStatus
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if let last = locations.last { location = last }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        heading = newHeading
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        // Erreurs transitoires (kCLErrorLocationUnknown) : on attend la prochaine mise à jour.
    }
}
