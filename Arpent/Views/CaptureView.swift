import SwiftUI
import AVFoundation
import SwiftData

/// Écran de prise de vue : aperçu caméra, mode auto (temps + distance) et déclencheur manuel.
struct CaptureView: View {
    let sequence: PhotoSequence
    /// Supprimer la séquence si on ferme sans avoir pris de photo (nouvelle séquence uniquement).
    var deleteIfEmpty = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @State private var controller: CaptureController?
    @State private var flash = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let controller {
                if controller.camera.isAvailable {
                    CameraPreview(session: controller.camera.session).ignoresSafeArea()
                }
                if flash { Color.white.opacity(0.6).ignoresSafeArea() }
                overlay(controller)
            }
        }
        .onAppear {
            let c = CaptureController(sequence: sequence)
            controller = c
            c.start()
            UIApplication.shared.isIdleTimerDisabled = true
        }
        .onDisappear {
            controller?.stop()
            UIApplication.shared.isIdleTimerDisabled = false
        }
        .onChange(of: controller?.shotCount) {
            flash = true
            withAnimation(.easeOut(duration: 0.25)) { flash = false }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: controller?.shotCount)
        .statusBarHidden()
    }

    @ViewBuilder
    private func overlay(_ c: CaptureController) -> some View {
        VStack {
            HStack {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.title2.bold())
                        .padding(12)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .accessibilityLabel("Terminer")
                Spacer()
                gpsBadge(c)
                Spacer()
                Text("\(sequence.photos.count)")
                    .font(.title2.monospacedDigit().bold())
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(.ultraThinMaterial, in: Capsule())
                    .accessibilityLabel("\(sequence.photos.count) photos")
            }
            .foregroundStyle(.white)
            .padding()

            if c.camera.isDenied || c.location.isDenied {
                warning("Autorisez l'appareil photo et la localisation dans Réglages > Arpent.")
            } else if !c.camera.isAvailable {
                warning("Caméra indisponible : une image de test sera utilisée.")
            }

            Spacer()

            if let message = c.message {
                warning(message)
            }

            Text(c.isAuto
                 ? "Auto : toutes les \(AppSettings.interval.formatted()) s si déplacement ≥ \(AppSettings.minDistance.formatted()) m"
                 : "Démarrez le mode auto ou prenez des photos à la main")
                .font(.footnote)
                .foregroundStyle(.white)
                .padding(8)
                .background(.black.opacity(0.4), in: Capsule())

            HStack(spacing: 40) {
                Button(action: c.toggleAuto) {
                    Image(systemName: c.isAuto ? "stop.fill" : "record.circle")
                        .font(.system(size: 28, weight: .bold))
                        .frame(width: 64, height: 64)
                        .background(c.isAuto ? Color.red : Color.white.opacity(0.25), in: Circle())
                        .foregroundStyle(.white)
                }
                .accessibilityLabel(c.isAuto ? "Arrêter le mode auto" : "Démarrer le mode auto")

                Button(action: c.manualShot) {
                    Circle()
                        .strokeBorder(.white, lineWidth: 5)
                        .background(Circle().fill(c.isCapturing ? .gray : .white).padding(8))
                        .frame(width: 80, height: 80)
                }
                .accessibilityLabel("Prendre une photo")

                Color.clear.frame(width: 64, height: 64)
            }
            .padding(.bottom, 30)
        }
    }

    private func gpsBadge(_ c: CaptureController) -> some View {
        let (color, text): (Color, String) = {
            let acc = c.location.location.map { "±\(Int($0.horizontalAccuracy)) m" } ?? ""
            switch c.gpsQuality {
            case .none: return (.red, "GPS…")
            case .poor: return (.red, "GPS \(acc)")
            case .ok: return (.orange, "GPS \(acc)")
            case .good: return (.green, "GPS \(acc)")
            }
        }()
        return Label(text, systemImage: "location.fill")
            .font(.subheadline.bold())
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(color.opacity(0.85), in: Capsule())
    }

    private func warning(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.white)
            .multilineTextAlignment(.center)
            .padding(10)
            .background(.orange.opacity(0.85), in: RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal)
    }

    private func close() {
        controller?.stop()
        if deleteIfEmpty && sequence.photos.isEmpty {
            Storage.delete(sequence, in: context)
        }
        dismiss()
    }
}

/// Aperçu vidéo de la caméra.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
