import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var token: String?
    var privacyMode = false
    var server = UserDefaults.standard.string(forKey: "server") ?? "http://127.0.0.1:8000"
    let session = URLSession(configuration: .ephemeral)

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "api")
        let bridgeScript = """
        (() => {
          let nextId = 0;
          const pending = new Map();
          window.receive = ({id, value, error}) => {
            const task = pending.get(id); if (!task) return;
            pending.delete(id); error ? task.reject(new Error(error)) : task.resolve(value);
          };
          window.panWatchDesktop = {
            request(path, body, server, method) {
              return new Promise((resolve, reject) => {
                const id = ++nextId; pending.set(id, {resolve, reject});
                window.webkit.messageHandlers.api.postMessage({id, path, body, server, method});
              });
            },
            configurePrivacy(hidden) {
              window.webkit.messageHandlers.api.postMessage({id: ++nextId, path: 'privacy', body: {hidden}});
            }
          };
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        web = WKWebView(frame: .zero, configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1120, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "PanWatch · 盯盘"
        window.minSize = NSSize(width: 980, height: 620)
        window.contentView = web
        window.isReleasedWhenClosed = false
        window.center()
        let resource = Bundle.main.url(forResource: "desktop", withExtension: "html", subdirectory: "Desktop")!
        web.loadFileURL(resource, allowingReadAccessTo: resource.deletingLastPathComponent())
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu()
        let item = NSMenuItem()
        menu.addItem(item)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 PanWatch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.submenu = appMenu
        NSApp.mainMenu = menu
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        web.evaluateJavaScript("window.dispatchEvent(new Event('panwatch:resume'))", completionHandler: nil)
        return true
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.request.url?.isFileURL == true,
              let input = message.body as? [String: Any], let id = input["id"] as? Int,
              let path = input["path"] as? String else { return }
        if path == "config" { reply(id, value: ["server": server, "privacy": privacyMode]); return }
        if path == "logout" { token = nil; return }
        if path == "privacy" {
            privacyMode = (input["body"] as? [String: Any])?["hidden"] as? Bool ?? false
            window.title = privacyMode ? "PanWatch · 隐私模式" : "PanWatch · 盯盘"
            return
        }
        if path.hasPrefix("open-web:") {
            let route = String(path.dropFirst("open-web:".count))
            guard ["/", "/portfolio", "/alerts", "/assistant"].contains(route),
                  let url = URL(string: server + route) else { reply(id, error: "不支持打开此网页"); return }
            NSWorkspace.shared.open(url)
            reply(id, value: ["opened": true])
            return
        }
        let route = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        let readRoutes: Set<String> = ["/stocks", "/portfolio/summary", "/stocks/markets/status", "/notifications/summary"]
        let acceptsPost = route == "/quotes/batch"
        let groupPath = route.range(of: "^/watch-groups/[0-9]+$", options: .regularExpression) != nil
        let membersPath = route.range(of: "^/watch-groups/[0-9]+/members$", options: .regularExpression) != nil
        let groupsCollection = route == "/watch-groups"
        let batchMembersPath = route == "/watch-groups/members"
        let isKline = route.range(of: "^/klines/[A-Za-z0-9.\\-]+$", options: .regularExpression) != nil
        let method = input["method"] as? String ?? (acceptsPost ? "POST" : "GET")
        let allowedMethod = readRoutes.contains(route) && method == "GET"
            || acceptsPost && method == "POST"
            || isKline && method == "GET"
            || groupsCollection && ["GET", "POST"].contains(method)
            || groupPath && ["PATCH", "DELETE"].contains(method)
            || membersPath && method == "PUT"
            || batchMembersPath && method == "PUT"
        guard path == "/auth/login" || allowedMethod else {
            reply(id, error: "此功能尚未开放"); return
        }
        if (acceptsPost || (method == "POST" && groupsCollection) || method == "PUT" || method == "PATCH" || path == "/auth/login"), input["body"] == nil {
            reply(id, error: "请求缺少必要内容"); return
        }
        if path == "/auth/login", let address = input["server"] as? String {
            guard let url = URL(string: address), let host = url.host, url.user == nil, url.password == nil,
                  url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil,
                  url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)) else {
                reply(id, error: "请输入 HTTPS 服务地址，本机服务也可使用 HTTP"); return
            }
            server = address.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            token = nil
        }
        guard let url = URL(string: server + "/api" + path) else { reply(id, error: "服务地址无效"); return }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = path == "/auth/login" ? "POST" : method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body = input["body"], (path == "/auth/login" || acceptsPost || method == "POST" || method == "PUT" || method == "PATCH") {
            request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        if path == "/auth/login" {
            // Verify the destination before sending credentials to it.
            var probe = URLRequest(url: URL(string: server + "/api/auth/status")!, timeoutInterval: 10)
            probe.setValue("application/json", forHTTPHeaderField: "Accept")
            session.dataTask(with: probe) { data, response, error in
                DispatchQueue.main.async {
                    if let error { self.reply(id, error: error.localizedDescription); return }
                    do {
                        try APIResponse.validateService(data, response: response)
                        self.perform(request, path: path, id: id)
                    } catch { self.reply(id, error: error.localizedDescription) }
                }
            }.resume()
        } else {
            perform(request, path: path, id: id)
        }
    }
    func perform(_ request: URLRequest, path: String, id: Int) {
        session.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
                if let error { self.reply(id, error: error.localizedDescription); return }
                do {
                    let result = try APIResponse.decode(data, response: response, login: path == "/auth/login")
                    if path == "/auth/login" {
                        guard let login = result as? [String: Any], let token = login["token"] as? String, !token.isEmpty else {
                            self.reply(id, error: "登录接口未返回有效凭证，请检查 PanWatch 服务版本"); return
                        }
                        self.token = token
                        UserDefaults.standard.set(self.server, forKey: "server")
                        self.reply(id, value: ["connected": true])
                    } else {
                        self.reply(id, value: result)
                    }
                } catch { self.reply(id, error: error.localizedDescription) }
            }
        }.resume()
    }
    func reply(_ id: Int, value: Any = NSNull(), error: String? = nil) {
        let payload: [String: Any] = ["id": id, "value": value, "error": error ?? NSNull()]
        guard let bytes = try? JSONSerialization.data(withJSONObject: payload) else { return }
        let encoded = bytes.base64EncodedString()
        web.evaluateJavaScript("window.receive(JSON.parse(atob('\(encoded)')))", completionHandler: nil)
    }
}
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
