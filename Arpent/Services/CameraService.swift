import AVFoundation
import UIKit

/// Appareil photo arrière. Les métadonnées GPS sont injectées sans recompression
/// via `AVCapturePhotoFileDataRepresentationCustomizer`.
/// Sans caméra (simulateur), une image de repli est générée pour pouvoir tester tout le reste.
@Observable
final class CameraService: NSObject, @unchecked Sendable {   // état interne protégé par `queue`
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "arpent.camera")
    @ObservationIgnored private var configured = false

    private(set) var isAvailable = false
    private(set) var isDenied = false

    private struct Pending {
        let continuation: CheckedContinuation<Data, Error>
        let info: ExifWriter.Info
    }
    @ObservationIgnored private var pending: [Int64: Pending] = [:]   // accès uniquement sur `queue`

    enum CameraError: LocalizedError {
        case noData
        var errorDescription: String? { "La photo n'a pas pu être enregistrée." }
    }

    @MainActor
    func start() async {
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        guard granted else {
            isDenied = true
            return
        }
        let available: Bool = await withCheckedContinuation { cont in
            queue.async {
                if !self.configured { self.configured = self.configure() }
                if self.configured && !self.session.isRunning { self.session.startRunning() }
                cont.resume(returning: self.configured)
            }
        }
        isAvailable = available
    }

    func stop() {
        queue.async {
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    /// À appeler sur `queue`.
    private func configure() -> Bool {
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device) else { return false }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .photo
        guard session.canAddInput(input), session.canAddOutput(output) else { return false }
        session.addInput(input)
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .speed
        return true
    }

    /// Prend une photo et renvoie le JPEG avec EXIF GPS.
    func capture(info: ExifWriter.Info, rotationAngle: CGFloat) async throws -> Data {
        guard isAvailable else {
            guard let data = Self.placeholderJPEG(date: info.date),
                  let tagged = ExifWriter.write(jpeg: data, info: info) else { throw CameraError.noData }
            return tagged
        }
        return try await withCheckedThrowingContinuation { cont in
            queue.async {
                if let connection = self.output.connection(with: .video),
                   connection.isVideoRotationAngleSupported(rotationAngle) {
                    connection.videoRotationAngle = rotationAngle
                }
                let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                settings.photoQualityPrioritization = .speed
                self.pending[settings.uniqueID] = Pending(continuation: cont, info: info)
                self.output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    /// Angle de rotation à appliquer à la photo selon l'orientation physique du téléphone.
    static func rotationAngle(for orientation: UIDeviceOrientation) -> CGFloat {
        switch orientation {
        case .landscapeLeft: return 0
        case .landscapeRight: return 180
        case .portraitUpsideDown: return 270
        default: return 90
        }
    }

    private static func placeholderJPEG(date: Date) -> Data? {
        let size = CGSize(width: 1600, height: 1200)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
            UIColor.systemTeal.setFill()
            ctx.fill(CGRect(origin: .zero, size: size))
            let text = "Arpent (simulateur)\n" + date.formatted(date: .numeric, time: .standard)
            let attrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.boldSystemFont(ofSize: 80),
                .foregroundColor: UIColor.white,
            ]
            (text as NSString).draw(in: CGRect(x: 80, y: 480, width: 1440, height: 400), withAttributes: attrs)
        }
        return image.jpegData(compressionQuality: 0.9)
    }
}

extension CameraService: AVCapturePhotoCaptureDelegate {
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        queue.async {
            let id = photo.resolvedSettings.uniqueID
            guard let request = self.pending.removeValue(forKey: id) else { return }
            if let error {
                request.continuation.resume(throwing: error)
                return
            }
            let customizer = MetadataCustomizer(info: request.info)
            if let data = photo.fileDataRepresentation(with: customizer) {
                request.continuation.resume(returning: data)
            } else {
                request.continuation.resume(throwing: CameraError.noData)
            }
        }
    }
}

private final class MetadataCustomizer: NSObject, AVCapturePhotoFileDataRepresentationCustomizer {
    let info: ExifWriter.Info
    init(info: ExifWriter.Info) { self.info = info }

    func replacementMetadata(for photo: AVCapturePhoto) -> [String: Any]? {
        ExifWriter.merge(photo.metadata, with: info)
    }
}
