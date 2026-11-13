import Foundation

/// Client minimal de l'API Panoramax (testé contre l'OpenAPI v2.17).
struct PanoramaxClient {
    let baseURL: URL
    var token: String?

    enum APIError: LocalizedError {
        case http(Int, String)
        case invalidResponse
        case notLoggedIn

        var errorDescription: String? {
            switch self {
            case .http(let code, let message):
                return message.isEmpty ? "Erreur serveur (\(code))." : "Erreur serveur (\(code)) : \(message)"
            case .invalidResponse:
                return "Réponse inattendue du serveur."
            case .notLoggedIn:
                return "Connectez-vous à Panoramax dans les réglages."
            }
        }

        var statusCode: Int? {
            if case .http(let code, _) = self { return code }
            return nil
        }
    }

    // MARK: Authentification

    struct ClaimableToken {
        let jwt: String
        let claimURL: URL
    }

    /// `POST /api/auth/tokens/generate` : jeton non utilisable tant qu'il n'est pas « réclamé » via le navigateur.
    func generateToken(description: String = "Arpent iOS") async throws -> ClaimableToken {
        var comps = URLComponents(url: url("api/auth/tokens/generate"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "description", value: description)]
        var request = URLRequest(url: comps.url!)
        request.httpMethod = "POST"

        struct Link: Decodable { let rel: String; let href: String }
        struct Response: Decodable { let jwt_token: String; let links: [Link] }
        let response: Response = try await send(request)

        guard let href = response.links.first(where: { $0.rel == "claim" })?.href,
              let claim = URL(string: href, relativeTo: baseURL)?.absoluteURL else {
            throw APIError.invalidResponse
        }
        return ClaimableToken(jwt: response.jwt_token, claimURL: claim)
    }

    struct User: Decodable {
        let id: String
        let name: String
    }

    /// `GET /api/users/me`
    func me() async throws -> User {
        try await send(authorized(URLRequest(url: url("api/users/me"))))
    }

    // MARK: Upload sets

    struct UploadSet: Decodable {
        let id: String
        let completed: Bool
        let ready: Bool
    }

    /// `POST /api/upload_sets`
    func createUploadSet(title: String, estimatedFiles: Int) async throws -> UploadSet {
        var request = try authorized(URLRequest(url: url("api/upload_sets")))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "title": title,
            "estimated_nb_files": estimatedFiles,
            "sort_method": "time-asc",
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    /// `POST /api/upload_sets/{id}/files` (multipart, champ `file`).
    /// Un 409 (photo déjà envoyée) est considéré comme un succès.
    func uploadFile(uploadSetId: String, fileURL: URL, fileName: String) async throws {
        let boundary = "Arpent-\(UUID().uuidString)"
        var request = try authorized(URLRequest(url: url("api/upload_sets/\(uploadSetId)/files")))
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120

        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n")
        body.append("Content-Type: image/jpeg\r\n\r\n")
        body.append(try Data(contentsOf: fileURL))
        body.append("\r\n--\(boundary)--\r\n")

        let (data, response) = try await URLSession.shared.upload(for: request, from: body)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(code) || code == 409 { return }
        throw APIError.http(code, Self.errorMessage(data))
    }

    /// `POST /api/upload_sets/{id}/complete`
    func completeUploadSet(_ uploadSetId: String) async throws {
        var request = try authorized(URLRequest(url: url("api/upload_sets/\(uploadSetId)/complete")))
        request.httpMethod = "POST"
        let _: UploadSet = try await send(request)
    }

    // MARK: Outils

    private func url(_ path: String) -> URL {
        baseURL.appending(path: path)
    }

    private func authorized(_ request: URLRequest) throws -> URLRequest {
        guard let token else { throw APIError.notLoggedIn }
        var r = request
        r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        return r
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(http.statusCode, Self.errorMessage(data))
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError.invalidResponse
        }
    }

    /// Extrait le champ `message` des erreurs JSON Panoramax.
    private static func errorMessage(_ data: Data) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = json["message"] as? String {
            return message
        }
        return String(data: data.prefix(200), encoding: .utf8) ?? ""
    }
}

private extension Data {
    mutating func append(_ string: String) {
        append(Data(string.utf8))
    }
}
