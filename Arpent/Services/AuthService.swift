import Foundation
import AuthenticationServices
import Security
import UIKit

/// Connexion à Panoramax sans saisir de mot de passe dans l'app :
/// 1. on génère un jeton « réclamable » ;
/// 2. l'utilisateur le réclame dans une feuille web (connexion OSM sur le site de l'instance) ;
/// 3. on vérifie le jeton avec `/api/users/me` puis on le garde dans le Keychain.
@MainActor
@Observable
final class AuthService: NSObject {
    private(set) var userName: String?
    private(set) var isWorking = false
    var errorMessage: String?

    private static let instanceKey = "tokenInstance"
    private static let userNameKey = "tokenUserName"
    private var webSession: ASWebAuthenticationSession?

    override init() {
        super.init()
        // Le jeton est lié à une instance : s'il a été obtenu ailleurs, on l'oublie.
        if Keychain.load() != nil, UserDefaults.standard.string(forKey: Self.instanceKey) == AppSettings.instanceURL?.absoluteString {
            userName = UserDefaults.standard.string(forKey: Self.userNameKey)
        } else {
            logout()
        }
    }

    var isLoggedIn: Bool { userName != nil }

    /// Jeton valide pour l'instance courante, sinon nil.
    var token: String? {
        guard isLoggedIn,
              UserDefaults.standard.string(forKey: Self.instanceKey) == AppSettings.instanceURL?.absoluteString
        else { return nil }
        return Keychain.load()
    }

    func login() async {
        guard let base = AppSettings.instanceURL else {
            errorMessage = "Adresse d'instance invalide."
            return
        }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }

        do {
            let claimable = try await PanoramaxClient(baseURL: base).generateToken()

            var comps = URLComponents(url: claimable.claimURL, resolvingAgainstBaseURL: false)!
            comps.queryItems = (comps.queryItems ?? []) + [URLQueryItem(name: "next_url", value: "arpent://auth-done")]
            // Si l'instance ne redirige pas vers arpent://, l'utilisateur ferme la feuille :
            // on vérifie quand même si le jeton a été réclamé.
            await openWebSession(comps.url!)

            let user = try await PanoramaxClient(baseURL: base, token: claimable.jwt).me()
            Keychain.save(claimable.jwt)
            UserDefaults.standard.set(base.absoluteString, forKey: Self.instanceKey)
            UserDefaults.standard.set(user.name, forKey: Self.userNameKey)
            userName = user.name
        } catch let error as PanoramaxClient.APIError where error.statusCode == 401 || error.statusCode == 403 {
            errorMessage = "Connexion non finalisée : connectez-vous sur la page web puis réessayez."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() {
        Keychain.delete()
        UserDefaults.standard.removeObject(forKey: Self.instanceKey)
        UserDefaults.standard.removeObject(forKey: Self.userNameKey)
        userName = nil
    }

    private func openWebSession(_ url: URL) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "arpent") { _, _ in
                cont.resume()
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            if !session.start() { cont.resume() }
        }
        webSession = nil
    }
}

extension AuthService: ASWebAuthenticationPresentationContextProviding {
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        }
    }
}

/// Stockage du jeton JWT dans le Keychain.
enum Keychain {
    private static let service = "org.arpent.app.panoramax-token"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service]
    }

    static func save(_ token: String) {
        delete()
        var q = query
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(q as CFDictionary, nil)
    }

    static func load() -> String? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
