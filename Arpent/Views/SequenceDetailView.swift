import SwiftUI
import SwiftData
import MapKit
import ImageIO

/// Détail d'une séquence : nom, carte du parcours, vignettes, suppression, envoi.
struct SequenceDetailView: View {
    @Bindable var sequence: PhotoSequence
    @Environment(\.modelContext) private var context
    @Environment(AuthService.self) private var auth
    @Environment(Uploader.self) private var uploader
    @State private var capturing = false

    private let columns = [GridItem(.adaptive(minimum: 100), spacing: 4)]

    var body: some View {
        let photos = sequence.sortedPhotos
        List {
            Section {
                TextField("Nom de la séquence", text: $sequence.name)
                    .onSubmit { try? context.save() }
            }

            if !photos.isEmpty {
                Section {
                    Map {
                        MapPolyline(coordinates: photos.map(\.coordinate))
                            .stroke(.blue, lineWidth: 3)
                        ForEach(photos) { photo in
                            Annotation("", coordinate: photo.coordinate) {
                                Circle()
                                    .fill(photo.uploaded ? .green : .blue)
                                    .frame(width: 8, height: 8)
                            }
                        }
                    }
                    .frame(height: 220)
                    .listRowInsets(EdgeInsets())
                }
            }

            Section {
                if let p = uploader.progress[sequence.id] {
                    ProgressView(value: p) { Text("Envoi en cours…") }
                } else if sequence.isFullyUploaded {
                    Label("Toutes les photos sont envoyées", systemImage: "checkmark.icloud")
                        .foregroundStyle(.green)
                } else {
                    Button {
                        Task { await uploader.upload(sequence, auth: auth) }
                    } label: {
                        Label("Envoyer \(sequence.pendingCount) photo(s) sur Panoramax", systemImage: "icloud.and.arrow.up")
                    }
                    .disabled(photos.isEmpty || uploader.isBusy)
                    if !auth.isLoggedIn {
                        Text("Connectez-vous d'abord dans les réglages.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }

            Section("\(photos.count) photo(s)") {
                LazyVGrid(columns: columns, spacing: 4) {
                    ForEach(photos) { photo in
                        Thumbnail(url: photo.fileURL)
                            .overlay(alignment: .topTrailing) {
                                if photo.uploaded {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundStyle(.white, .green)
                                        .padding(4)
                                }
                            }
                            .contextMenu {
                                Button(role: .destructive) {
                                    Storage.delete(photo, in: context)
                                } label: {
                                    Label("Supprimer", systemImage: "trash")
                                }
                            }
                    }
                }
                .listRowInsets(EdgeInsets(top: 4, leading: 4, bottom: 4, trailing: 4))
            }
        }
        .navigationTitle(sequence.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { capturing = true } label: {
                    Label("Continuer", systemImage: "camera")
                }
                .disabled(uploader.isUploading(sequence))
            }
        }
        .fullScreenCover(isPresented: $capturing) {
            CaptureView(sequence: sequence)
        }
        .onDisappear { try? context.save() }
    }
}

/// Vignette chargée et réduite en arrière-plan.
struct Thumbnail: View {
    let url: URL?
    @State private var image: UIImage?

    var body: some View {
        Color.secondary.opacity(0.2)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                }
            }
            .clipped()
            .task(id: url) { image = await Self.load(url) }
    }

    private static func load(_ url: URL?) async -> UIImage? {
        guard let url else { return nil }
        return await Task.detached(priority: .utility) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 300,
            ]
            guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
            return UIImage(cgImage: cg)
        }.value
    }
}
