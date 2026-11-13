import SwiftUI
import SwiftData

@main
struct ArpentApp: App {
    @State private var auth = AuthService()
    @State private var uploader = Uploader()

    init() {
        AppSettings.registerDefaults()
    }

    var body: some Scene {
        WindowGroup {
            SequenceListView()
                .environment(auth)
                .environment(uploader)
        }
        .modelContainer(for: [PhotoSequence.self, CapturedPhoto.self])
    }
}
