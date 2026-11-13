import SwiftUI
import SwiftData

/// Écran d'accueil : liste des séquences, nouvelle séquence, envoi groupé.
struct SequenceListView: View {
    @Environment(\.modelContext) private var context
    @Environment(AuthService.self) private var auth
    @Environment(Uploader.self) private var uploader
    @Query(sort: \PhotoSequence.createdAt, order: .reverse) private var sequences: [PhotoSequence]

    @State private var capturing: PhotoSequence?
    @State private var showSettings = false

    private var pendingSequences: [PhotoSequence] {
        sequences.filter { $0.pendingCount > 0 }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(sequences) { sequence in
                    NavigationLink(value: sequence) {
                        SequenceRow(sequence: sequence)
                    }
                }
                .onDelete { offsets in
                    for index in offsets { Storage.delete(sequences[index], in: context) }
                }
            }
            .overlay {
                if sequences.isEmpty {
                    ContentUnavailableView(
                        "Aucune séquence",
                        systemImage: "camera.viewfinder",
                        description: Text("Lancez une nouvelle séquence pour photographier votre parcours.")
                    )
                }
            }
            .navigationTitle("Arpent")
            .navigationDestination(for: PhotoSequence.self) { sequence in
                SequenceDetailView(sequence: sequence)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .accessibilityLabel("Réglages")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await uploader.upload(pendingSequences, auth: auth) }
                    } label: {
                        Label("Tout envoyer", systemImage: "icloud.and.arrow.up")
                    }
                    .disabled(pendingSequences.isEmpty || uploader.isBusy)
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button(action: newSequence) {
                    Label("Nouvelle séquence", systemImage: "camera.fill")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .padding()
                .background(.bar)
            }
            .fullScreenCover(item: $capturing) { sequence in
                CaptureView(sequence: sequence, deleteIfEmpty: true)
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
            .alert("Envoi impossible", isPresented: errorBinding) {
                Button("OK") { uploader.errorMessage = nil }
            } message: {
                Text(uploader.errorMessage ?? "")
            }
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { uploader.errorMessage != nil }, set: { if !$0 { uploader.errorMessage = nil } })
    }

    private func newSequence() {
        let sequence = PhotoSequence(name: PhotoSequence.defaultName())
        context.insert(sequence)
        try? context.save()
        capturing = sequence
    }
}

struct SequenceRow: View {
    let sequence: PhotoSequence
    @Environment(Uploader.self) private var uploader

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(sequence.name).font(.headline)
            HStack(spacing: 6) {
                Text("\(sequence.photos.count) photo\(sequence.photos.count > 1 ? "s" : "")")
                if sequence.isFullyUploaded {
                    Label("Envoyée", systemImage: "checkmark.icloud").foregroundStyle(.green)
                } else if sequence.uploadedCount > 0 {
                    Text("· \(sequence.uploadedCount) envoyée(s)")
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            if let p = uploader.progress[sequence.id] {
                ProgressView(value: p)
            }
        }
    }
}
