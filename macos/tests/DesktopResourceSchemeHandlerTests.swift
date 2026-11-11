import Foundation

@main
struct DesktopResourceSchemeHandlerTests {
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("panwatch-scheme-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("assets", isDirectory: true), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("<html></html>".utf8).write(to: root.appendingPathComponent("desktop.html"))
        try Data("console.log('ok')".utf8).write(to: root.appendingPathComponent("assets/main.js"))

        let document = URL(string: "panwatch-desktop://desktop/desktop.html?mode=main")!
        let mini = URL(string: "panwatch-desktop://desktop/desktop.html?mode=mini")!
        let script = URL(string: "panwatch-desktop://desktop/assets/main.js")!
        precondition(DesktopResourceSchemeHandler.isDesktopDocument(document))
        precondition(DesktopResourceSchemeHandler.isDesktopDocument(mini))
        precondition(!DesktopResourceSchemeHandler.isDesktopDocument(URL(string: "panwatch-desktop://other/desktop.html?mode=main")))
        precondition(!DesktopResourceSchemeHandler.isDesktopDocument(URL(string: "panwatch-desktop://desktop/desktop.html?mode=other")))
        precondition(DesktopResourceSchemeHandler.resourceURL(for: document, under: root)?.lastPathComponent == "desktop.html")
        precondition(DesktopResourceSchemeHandler.resourceURL(for: script, under: root)?.lastPathComponent == "main.js")
        precondition(DesktopResourceSchemeHandler.resourceURL(for: URL(string: "panwatch-desktop://desktop/%2E%2E/private.txt")!, under: root) == nil)
        precondition(DesktopResourceSchemeHandler.resourceURL(for: URL(string: "panwatch-desktop://desktop/../private.txt")!, under: root) == nil)
        precondition(DesktopResourceSchemeHandler.resourceURL(for: URL(string: "panwatch-desktop://other/assets/main.js")!, under: root) == nil)
        precondition(DesktopResourceSchemeHandler.resourceURL(for: URL(string: "panwatch-desktop://desktop/assets/main.js?next=private")!, under: root) == nil)
        precondition(DesktopResourceSchemeHandler.mimeType(for: script) == "text/javascript")
        print("Desktop resource scheme checks passed")
    }
}
