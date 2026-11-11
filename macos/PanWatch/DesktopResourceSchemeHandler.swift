import Foundation
import WebKit

final class DesktopResourceSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "panwatch-desktop"
    private let root: URL

    init(root: URL) {
        self.root = root.standardizedFileURL
        super.init()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let method = urlSchemeTask.request.httpMethod?.uppercased()
        guard let url = urlSchemeTask.request.url,
              method == nil || method == "GET",
              let fileURL = Self.resourceURL(for: url, under: root),
              let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        let response = URLResponse(
            url: url,
            mimeType: Self.mimeType(for: fileURL),
            expectedContentLength: data.count,
            textEncodingName: Self.textEncoding(for: fileURL)
        )
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    static func isDesktopDocument(_ url: URL?) -> Bool {
        guard let url,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == scheme,
              components.host?.lowercased() == "desktop",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.percentEncodedPath == "/desktop.html",
              components.fragment == nil,
              let queryItems = components.queryItems,
              queryItems.count == 1,
              queryItems[0].name == "mode",
              ["main", "mini"].contains(queryItems[0].value ?? "") else { return false }
        return true
    }

    static func resourceURL(for url: URL, under root: URL) -> URL? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == scheme,
              components.host?.lowercased() == "desktop",
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.fragment == nil,
              !components.percentEncodedPath.isEmpty,
              components.percentEncodedPath.hasPrefix("/"),
              !components.percentEncodedPath.contains("//"),
              !components.percentEncodedPath.contains("\\"),
              !components.percentEncodedPath.contains("%"),
              components.percentEncodedPath.unicodeScalars.allSatisfy({ CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-/").contains($0) }) else { return nil }

        let rawPath = components.percentEncodedPath

        let pathSegments = rawPath.dropFirst().split(separator: "/", omittingEmptySubsequences: false)
        guard !pathSegments.isEmpty,
              pathSegments.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { return nil }

        if rawPath == "/desktop.html" {
            guard let queryItems = components.queryItems,
                  queryItems.count == 1,
                  queryItems[0].name == "mode",
                  ["main", "mini"].contains(queryItems[0].value ?? "") else { return nil }
        } else if !(components.queryItems ?? []).isEmpty {
            return nil
        }

        let base = root.standardizedFileURL
        let candidate = base.appendingPathComponent(pathSegments.joined(separator: "/"), isDirectory: false).standardizedFileURL
        guard candidate.path.hasPrefix(base.path + "/"),
              (try? candidate.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return candidate
    }

    static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "html": "text/html"
        case "js", "mjs": "text/javascript"
        case "css": "text/css"
        case "json", "webmanifest": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "webp": "image/webp"
        case "ico": "image/x-icon"
        case "woff": "font/woff"
        case "woff2": "font/woff2"
        case "ttf": "font/ttf"
        case "wasm": "application/wasm"
        default: "application/octet-stream"
        }
    }

    private static func textEncoding(for url: URL) -> String? {
        ["html", "js", "mjs", "css", "json", "webmanifest", "svg"].contains(url.pathExtension.lowercased()) ? "utf-8" : nil
    }
}
