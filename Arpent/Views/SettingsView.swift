import SwiftUI

/// Réglages : instance Panoramax, compte, paramètres de capture.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(AuthService.self) private var auth

    @AppStorage(AppSettings.instanceURLKey) private var instanceURL = AppSettings.defaultInstance
    @AppStorage(AppSettings.intervalKey) private var interval = AppSettings.defaultInterval
    @AppStorage(AppSettings.minDistanceKey) private var minDistance = AppSettings.defaultMinDistance
    @AppStorage(AppSettings.maxAccuracyKey) private var maxAccuracy = AppSettings.defaultMaxAccuracy
    @AppStorage(AppSettings.deleteAfterUploadKey) private var deleteAfterUpload = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://panoramax.openstreetmap.fr", text: $instanceURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .onChange(of: instanceURL) {
                            // Un jeton n'est valable que pour son instance.
                            if auth.isLoggedIn { auth.logout() }
                        }
                } header: {
                    Text("Instance Panoramax")
                }

                Section {
                    if let name = auth.userName {
                        LabeledContent("Connecté", value: name)
                        Button("Se déconnecter", role: .destructive) { auth.logout() }
                    } else {
                        Button {
                            Task { await auth.login() }
                        } label: {
                            if auth.isWorking {
                                ProgressView()
                            } else {
                                Text("Se connecter")
                            }
                        }
                        .disabled(auth.isWorking)
                    }
                    if let error = auth.errorMessage {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                } header: {
                    Text("Compte")
                } footer: {
                    Text("La connexion se fait sur le site de l'instance (compte OpenStreetMap). Aucun mot de passe n'est stocké dans l'app.")
                }

                Section {
                    Stepper("Intervalle : \(interval.formatted()) s", value: $interval, in: 1...10, step: 1)
                    Stepper("Distance minimale : \(Int(minDistance)) m", value: $minDistance, in: 1...30, step: 1)
                    Stepper("Précision GPS max : \(Int(maxAccuracy)) m", value: $maxAccuracy, in: 5...50, step: 5)
                } header: {
                    Text("Capture automatique")
                } footer: {
                    Text("Une photo est prise à chaque intervalle uniquement si vous vous êtes déplacé d'au moins la distance minimale. À l'arrêt, aucune photo n'est prise.")
                }

                Section {
                    Toggle("Supprimer les photos du téléphone après envoi", isOn: $deleteAfterUpload)
                }
            }
            .navigationTitle("Réglages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("OK") { dismiss() }
                }
            }
        }
    }
}
