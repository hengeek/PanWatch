import AppKit
import Carbon.HIToolbox
import Security
import ServiceManagement
import UserNotifications
import WebKit

private func panWatchHotKeyHandler(_ nextHandler: EventHandlerCallRef?, _ event: EventRef?, _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event, let userData else { return noErr }
    var hotKey = EventHotKeyID()
    let status = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &hotKey)
    guard status == noErr, hotKey.id == 1 else { return noErr }
    let delegate = Unmanaged<AppDelegate>.fromOpaque(userData).takeUnretainedValue()
    delegate.toggleMainWindow()
    return noErr
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate, URLSessionTaskDelegate, UNUserNotificationCenterDelegate {
    private var mainWindow: NSWindow!
    private var miniWindow: NSPanel?
    private var mainWeb: WKWebView!
    private var miniWeb: WKWebView?
    private var statusItem: NSStatusItem!
    private var summaryMenuItem: NSMenuItem?
    private var token: String?
    private var server: String
    private var privacyMode: Bool
    private var requestTasks: [String: URLSessionDataTask] = [:]
    private let keychain = KeychainSessionStore()
    private var notificationTimer: Timer?
    private var hotKeyRef: EventHotKeyRef?
    private var hotKeyHandlerRef: EventHandlerRef?
    private var notificationCursor: Int64 = 0
    private var miniAlwaysOnTop: Bool
    private var latestSnapshot: [String: Any]?
    private var notificationAmountsHidden: Bool

    private let defaults = UserDefaults.standard
    private lazy var session: URLSession = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView === miniWeb { broadcastSnapshot() }
    }

    override init() {
        server = defaults.string(forKey: "server") ?? "http://127.0.0.1:8000"
        privacyMode = defaults.bool(forKey: "privacy")
        miniAlwaysOnTop = defaults.object(forKey: "miniAlwaysOnTop") as? Bool ?? true
        notificationAmountsHidden = defaults.object(forKey: "hideNotificationAmounts") as? Bool ?? true
        super.init()
        defaults.register(defaults: [
            "autoRefresh": true,
            "refreshInterval": 30,
            "rememberSession": false,
            "notificationsEnabled": false,
            "hotkeyEnabled": true,
            "launchAtLogin": false,
            "miniAlwaysOnTop": true,
            "hideNotificationAmounts": true,
        ])
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMainWindow()
        buildStatusMenu()
        _ = registerHotKey(defaults.bool(forKey: "hotkeyEnabled"))
        configureNotifications()
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        loadWebView(mainWeb, mode: "main")
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showMainWindow()
        mainWeb.evaluateJavaScript("window.dispatchEvent(new Event('panwatch:resume'))", completionHandler: nil)
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func applicationWillTerminate(_ notification: Notification) {
        notificationTimer?.invalidate()
        notificationTimer = nil
        for task in requestTasks.values { task.cancel() }
        requestTasks.removeAll()
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame,
              let input = message.body as? [String: Any],
              let requestID = input["id"] as? String,
              let path = input["path"] as? String else { return }
        guard let webView = message.webView ?? mainWeb else { return }
        guard isBundledPage(message.frameInfo.request.url) else { return }

        if path == "native:config" {
            reply(requestID, to: webView, value: configuration())
            return
        }
        if path == "native:session-restore" {
            restoreSession(requestID, webView: webView)
            return
        }
        if path == "native:logout" {
            clearSession(removeSaved: true)
            reply(requestID, to: webView, value: ["loggedOut": true])
            return
        }
        if path == "native:preferences" {
            updatePreferences(input["body"] as? [String: Any] ?? [:], requestID: requestID, webView: webView)
            return
        }
        if path == "native:window:main" {
            showMainWindow()
            reply(requestID, to: webView, value: ["visible": true])
            return
        }
        if path == "native:window:mini" {
            toggleMiniWindow()
            reply(requestID, to: webView, value: ["visible": miniWindow?.isVisible ?? false])
            return
        }
        if path == "native:mini-ready" {
            broadcastSnapshot()
            reply(requestID, to: webView, value: ["ready": true])
            return
        }
        if path == "native:notifications" {
            updateNotificationPermission(input["body"] as? [String: Any] ?? [:], requestID: requestID, webView: webView)
            return
        }
        if path == "native:menu-summary" {
            updateMenuSummary(input["body"] as? [String: Any] ?? [:])
            reply(requestID, to: webView, value: ["updated": true])
            return
        }
        if path == "native:snapshot" {
            latestSnapshot = input["body"] as? [String: Any]
            broadcastSnapshot()
            reply(requestID, to: webView, value: ["updated": true])
            return
        }
        if path == "native:select-stock" {
            guard let key = (input["body"] as? [String: Any])?["key"] as? String,
                  key.range(of: #"^(CN|HK|US):[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil else {
                reply(requestID, to: webView, error: "股票代码无效")
                return
            }
            showMainWindow()
            if let data = try? JSONSerialization.data(withJSONObject: ["key": key]),
               let json = String(data: data, encoding: .utf8) {
                let encoded = Data(json.utf8).base64EncodedString()
                mainWeb.evaluateJavaScript("window.dispatchEvent(new CustomEvent('panwatch:select-stock',{detail:window.__panWatchDecode('\(encoded)')}))", completionHandler: nil)
            }
            reply(requestID, to: webView, value: ["selected": true])
            return
        }
        if path == "native:cancel" {
            let cancelledID = (input["body"] as? [String: Any])?["requestId"] as? String
            if let cancelledID { requestTasks.removeValue(forKey: cancelledID)?.cancel() }
            return
        }
        if path == "privacy" {
            privacyMode = (input["body"] as? [String: Any])?["hidden"] as? Bool ?? false
            defaults.set(privacyMode, forKey: "privacy")
            updateWindowTitles()
            broadcastPrivacy()
            return
        }
        if path.hasPrefix("open-web:") {
            openWeb(String(path.dropFirst("open-web:".count)), requestID: requestID, webView: webView)
            return
        }
        performAPIRequest(input, path: path, requestID: requestID, webView: webView)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard let old = task.originalRequest?.url, let next = request.url,
              old.scheme == next.scheme,
              old.host?.lowercased() == next.host?.lowercased(),
              normalizedPort(old) == normalizedPort(next) else {
            completionHandler(nil)
            return
        }
        completionHandler(request)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let notificationID = response.notification.request.content.userInfo["notificationID"] as? Int
        DispatchQueue.main.async {
            self.showMainWindow()
            if let notificationID {
                let safeID = notificationID
                self.mainWeb.evaluateJavaScript("window.dispatchEvent(new CustomEvent('panwatch:notification',{detail:{id:\(safeID)}}))", completionHandler: nil)
            }
            completionHandler()
        }
    }

    func toggleMainWindow() {
        if mainWindow.isVisible { mainWindow.orderOut(nil) }
        else { showMainWindow() }
    }

    private func buildMainWindow() {
        let configuration = makeWebConfiguration()
        mainWeb = WKWebView(frame: .zero, configuration: configuration)
        mainWeb.navigationDelegate = self
        mainWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1220, height: 820), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        mainWindow.title = privacyMode ? "PanWatch · 隐私模式" : "PanWatch · 盯盘"
        mainWindow.titlebarAppearsTransparent = false
        mainWindow.minSize = NSSize(width: 980, height: 640)
        mainWindow.contentView = mainWeb
        mainWindow.isReleasedWhenClosed = false
        mainWindow.setFrameAutosaveName("PanWatchMainWindow")
        mainWindow.delegate = self
        mainWindow.center()
    }

    private func makeWebConfiguration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "api")
        if let document = Bundle.main.url(forResource: "desktop", withExtension: "html", subdirectory: "Desktop") {
            configuration.setURLSchemeHandler(
                DesktopResourceSchemeHandler(root: document.deletingLastPathComponent()),
                forURLScheme: DesktopResourceSchemeHandler.scheme
            )
        }
        let source = """
        (() => {
          // `crypto.randomUUID()` is limited to secure contexts and is not
          // available in every WKWebView version supported by macOS 12.
          // The request IDs are only local correlation keys, so a non-crypto
          // fallback is sufficient for older WebKit runtimes.
          const requestPrefix = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
          let nextId = 0;
          const pending = new Map();
          window.__panWatchDecode = encoded => {
            const binary = atob(encoded);
            const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
            return JSON.parse(new TextDecoder('utf-8').decode(bytes));
          };
          window.receive = ({id, value, error}) => {
            const task = pending.get(id); if (!task) return;
            pending.delete(id); task.cleanup?.(); error ? task.reject(new Error(error)) : task.resolve(value);
          };
          window.panWatchDesktop = {
            request(path, body, server, method, options = {}) {
              return new Promise((resolve, reject) => {
                const id = `${requestPrefix}:${++nextId}`;
                const finishAbort = () => {
                  pending.delete(id);
                  window.webkit.messageHandlers.api.postMessage({id: ++nextId, path:'native:cancel', body:{requestId:id}});
                  reject(new DOMException('请求已取消', 'AbortError'));
                };
                if (options.signal?.aborted) { reject(new DOMException('请求已取消', 'AbortError')); return; }
                const cleanup = () => options.signal?.removeEventListener('abort', finishAbort);
                pending.set(id, {resolve, reject, cleanup});
                options.signal?.addEventListener('abort', finishAbort, {once:true});
                window.webkit.messageHandlers.api.postMessage({id, path, body, server, method, timeoutMs:options.timeoutMs});
              });
            },
            configurePrivacy(hidden) {
              window.webkit.messageHandlers.api.postMessage({id: ++nextId, path:'privacy', body:{hidden}});
            }
          };
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        return configuration
    }

    private func buildStatusMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "PW"
        statusItem.button?.toolTip = "PanWatch 盯盘"
        let menu = NSMenu()
        summaryMenuItem = NSMenuItem(title: "PanWatch · 等待行情", action: nil, keyEquivalent: "")
        summaryMenuItem?.isEnabled = false
        if let summaryMenuItem { menu.addItem(summaryMenuItem) }
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "显示主窗口", action: #selector(showMainFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "显示迷你盯盘", action: #selector(toggleMiniFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: privacyMode ? "关闭隐私模式" : "开启隐私模式", action: #selector(togglePrivacyFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "手动刷新", action: #selector(refreshFromMenu), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "退出 PanWatch", action: #selector(quitFromMenu), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu

        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出 PanWatch", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        NSApp.mainMenu = mainMenu
    }

    @objc private func showMainFromMenu() { showMainWindow() }
    @objc private func toggleMiniFromMenu() { toggleMiniWindow() }
    @objc private func togglePrivacyFromMenu() {
        privacyMode.toggle()
        defaults.set(privacyMode, forKey: "privacy")
        updateWindowTitles()
        broadcastPrivacy()
    }

    private func broadcastPrivacy() {
        let js = "window.dispatchEvent(new CustomEvent('panwatch:privacy',{detail:{hidden:\(privacyMode)}}))"
        mainWeb?.evaluateJavaScript(js, completionHandler: nil)
        miniWeb?.evaluateJavaScript(js, completionHandler: nil)
    }
    @objc private func refreshFromMenu() { mainWeb.evaluateJavaScript("window.dispatchEvent(new Event('panwatch:resume'))", completionHandler: nil) }
    @objc private func quitFromMenu() { NSApp.terminate(nil) }

    private func makeMiniWindow() {
        let web = WKWebView(frame: .zero, configuration: makeWebConfiguration())
        web.navigationDelegate = self
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 360, height: 460), styleMask: [.titled, .closable, .resizable, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "PanWatch · 迷你盯盘"
        panel.minSize = NSSize(width: 310, height: 300)
        panel.isFloatingPanel = true
        panel.level = miniAlwaysOnTop ? .floating : .normal
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.contentView = web
        panel.setFrameAutosaveName("PanWatchMiniWindow")
        panel.delegate = self
        miniWindow = panel
        miniWeb = web
        loadWebView(web, mode: "mini")
    }

    private func toggleMiniWindow() {
        if miniWindow == nil { makeMiniWindow() }
        guard let miniWindow else { return }
        if miniWindow.isVisible { miniWindow.orderOut(nil) }
        else {
            miniWindow.level = miniAlwaysOnTop ? .floating : .normal
            miniWindow.makeKeyAndOrderFront(nil)
            broadcastSnapshot()
        }
    }

    private func loadWebView(_ web: WKWebView, mode: String) {
        guard Bundle.main.url(forResource: "desktop", withExtension: "html", subdirectory: "Desktop") != nil else { return }
        var components = URLComponents()
        components.scheme = DesktopResourceSchemeHandler.scheme
        components.host = "desktop"
        components.path = "/desktop.html"
        components.queryItems = [URLQueryItem(name: "mode", value: mode)]
        guard let url = components.url else { return }
        web.load(URLRequest(url: url))
    }

    private func isBundledPage(_ url: URL?) -> Bool {
        DesktopResourceSchemeHandler.isDesktopDocument(url)
    }

    private func showMainWindow() {
        miniWindow?.orderOut(nil)
        mainWindow.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func updateWindowTitles() {
        mainWindow.title = privacyMode ? "PanWatch · 隐私模式" : "PanWatch · 盯盘"
        miniWindow?.title = privacyMode ? "PanWatch · 隐私模式" : "PanWatch · 迷你盯盘"
    }

    private func configuration() -> [String: Any] {
        [
            "server": server,
            "privacy": privacyMode,
            "autoRefresh": defaults.bool(forKey: "autoRefresh"),
            "refreshInterval": defaults.integer(forKey: "refreshInterval") == 0 ? 30 : defaults.integer(forKey: "refreshInterval"),
            "rememberSession": defaults.bool(forKey: "rememberSession"),
            "sessionAvailable": keychain.read(server: server) != nil,
            "notificationsEnabled": defaults.bool(forKey: "notificationsEnabled"),
            "hotkeyEnabled": defaults.bool(forKey: "hotkeyEnabled"),
            "hotkeyStatus": hotKeyRef == nil ? (defaults.bool(forKey: "hotkeyEnabled") ? "conflict" : "disabled") : "enabled",
            "launchAtLogin": launchAtLoginStatus(),
            "miniAlwaysOnTop": miniAlwaysOnTop,
            "hideNotificationAmounts": notificationAmountsHidden,
        ]
    }

    private func updatePreferences(_ patch: [String: Any], requestID: String, webView: WKWebView) {
        if let value = patch["autoRefresh"] as? Bool { defaults.set(value, forKey: "autoRefresh") }
        if let value = patch["refreshInterval"] as? Int { defaults.set(max(10, min(300, value)), forKey: "refreshInterval") }
        if let value = patch["rememberSession"] as? Bool { defaults.set(value, forKey: "rememberSession") }
        if let value = patch["miniAlwaysOnTop"] as? Bool {
            miniAlwaysOnTop = value
            defaults.set(value, forKey: "miniAlwaysOnTop")
            miniWindow?.level = value ? .floating : .normal
        }
        if let value = patch["hideNotificationAmounts"] as? Bool {
            notificationAmountsHidden = value
            defaults.set(value, forKey: "hideNotificationAmounts")
        }
        var result: [String: Any] = ["ok": true]
        if let enabled = patch["hotkeyEnabled"] as? Bool {
            defaults.set(enabled, forKey: "hotkeyEnabled")
            result["hotkeyStatus"] = registerHotKey(enabled) ? "enabled" : (enabled ? "conflict" : "disabled")
        }
        if let enabled = patch["launchAtLogin"] as? Bool {
            do {
                try setLaunchAtLogin(enabled)
                defaults.set(enabled, forKey: "launchAtLogin")
                result["launchAtLogin"] = enabled
            } catch {
                result["ok"] = false
                result["error"] = error.localizedDescription
            }
        }
        reply(requestID, to: webView, value: result)
    }

    private func registerHotKey(_ enabled: Bool) -> Bool {
        if let hotKeyRef { UnregisterEventHotKey(hotKeyRef); self.hotKeyRef = nil }
        guard enabled else { return true }
        if hotKeyHandlerRef == nil {
            var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), panWatchHotKeyHandler, 1, &eventType, Unmanaged.passUnretained(self).toOpaque(), &hotKeyHandlerRef)
            guard status == noErr else { return false }
        }
        let identifier = EventHotKeyID(signature: OSType(0x50574D57), id: 1)
        var reference: EventHotKeyRef?
        let status = RegisterEventHotKey(UInt32(kVK_ANSI_P), UInt32(cmdKey | optionKey), identifier, GetApplicationEventTarget(), 0, &reference)
        guard status == noErr, let reference else { return false }
        hotKeyRef = reference
        return true
    }

    private func setLaunchAtLogin(_ enabled: Bool) throws {
        guard #available(macOS 13.0, *) else {
            throw APIResponseError(message: "系统登录项需要 macOS 13 或更新版本")
        }
        if enabled { try SMAppService.mainApp.register() }
        else { try SMAppService.mainApp.unregister() }
    }

    private func launchAtLoginStatus() -> Bool {
        guard #available(macOS 13.0, *) else { return false }
        return SMAppService.mainApp.status == .enabled
    }

    private func configureNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        notificationTimer?.invalidate()
        guard defaults.bool(forKey: "notificationsEnabled") else { return }
        notificationTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.pollNotifications() }
    }

    private func updateNotificationPermission(_ body: [String: Any], requestID: String, webView: WKWebView) {
        let enabled = body["enabled"] as? Bool ?? false
        if !enabled {
            defaults.set(false, forKey: "notificationsEnabled")
            notificationTimer?.invalidate(); notificationTimer = nil
            reply(requestID, to: webView, value: ["enabled": false])
            return
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            DispatchQueue.main.async {
                if let error {
                    self.reply(requestID, to: webView, error: error.localizedDescription)
                    return
                }
                self.defaults.set(granted, forKey: "notificationsEnabled")
                self.configureNotifications()
                self.reply(requestID, to: webView, value: ["enabled": granted])
            }
        }
    }

    private func pollNotifications() {
        guard token != nil else { return }
        backgroundGET("/notifications/summary") { [weak self] result in
            guard let self, case .success(let data) = result,
                  let summary = data as? [String: Any], let observed = summary["observed_id"] as? Int64 else { return }
            let cursorKey = "notificationCursor:\(self.server)"
            let saved = self.defaults.object(forKey: cursorKey) as? Int64
            if saved == nil {
                self.defaults.set(observed, forKey: cursorKey)
                return
            }
            let last = saved ?? 0
            guard observed > last else { return }
            self.fetchNotificationPages(cursor: nil, after: last, cursorKey: cursorKey, observed: observed, pages: 0)
        }
    }

    private func fetchNotificationPages(cursor: String?, after lastID: Int64, cursorKey: String, observed: Int64, pages: Int) {
        guard pages < 10 else { defaults.set(observed, forKey: cursorKey); return }
        var path = "/notifications?view=all&limit=100"
        if let cursor { path += "&cursor=" + cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)!.replacingOccurrences(of: "+", with: "%2B") }
        backgroundGET(path) { [weak self] result in
            guard let self, case .success(let data) = result, let page = data as? [String: Any] else { return }
            let items = page["items"] as? [[String: Any]] ?? []
            for item in items {
                guard let rawID = item["id"] as? Int64, rawID > lastID,
                      (item["toast_eligible"] as? Bool ?? false),
                      item["archived_at"] is NSNull || item["archived_at"] == nil else { continue }
                self.scheduleNotification(id: Int(rawID), item: item)
            }
            if let next = page["next_cursor"] as? String, !next.isEmpty {
                self.fetchNotificationPages(cursor: next, after: lastID, cursorKey: cursorKey, observed: observed, pages: pages + 1)
            } else {
                self.defaults.set(observed, forKey: cursorKey)
            }
        }
    }

    private func scheduleNotification(id: Int, item: [String: Any]) {
        let content = UNMutableNotificationContent()
        content.title = String((item["title"] as? String ?? "PanWatch 通知").prefix(80))
        content.body = notificationAmountsHidden ? "有一条新的盯盘通知，点击查看详情。" : String((item["template_key"] as? String ?? "有新的盯盘事件").prefix(160))
        content.sound = .default
        content.userInfo = ["notificationID": id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "panwatch-\(id)", content: content, trigger: nil))
    }

    private func backgroundGET(_ path: String, completion: @escaping (Result<Any, Error>) -> Void) {
        guard let token, let url = URL(string: server + "/api" + path) else { return }
        var request = URLRequest(url: url, timeoutInterval: 15)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        session.dataTask(with: request) { data, response, error in
            if let error { completion(.failure(error)); return }
            do { completion(.success(try APIResponse.decode(data, response: response))) }
            catch { completion(.failure(error)) }
        }.resume()
    }

    private func restoreSession(_ requestID: String, webView: WKWebView) {
        guard let saved = keychain.read(server: server) else {
            reply(requestID, to: webView, value: ["connected": false])
            return
        }
        token = saved
        backgroundGET("/stocks") { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                if case .success = result {
                    self.configureNotifications()
                    self.reply(requestID, to: webView, value: ["connected": true])
                } else {
                    self.clearSession(removeSaved: true)
                    self.reply(requestID, to: webView, value: ["connected": false])
                }
            }
        }
    }

    private func clearSession(removeSaved: Bool) {
        if removeSaved { keychain.delete(server: server) }
        token = nil
        notificationTimer?.invalidate(); notificationTimer = nil
        let cursorKey = "notificationCursor:\(server)"
        defaults.removeObject(forKey: cursorKey)
    }

    private func openWeb(_ route: String, requestID: String, webView: WKWebView) {
        let allowed: Set<String> = ["/", "/portfolio", "/alerts", "/assistant", "/opportunities", "/history"]
        guard allowed.contains(route), let url = URL(string: server + route), url.scheme == "https" || url.host == "127.0.0.1" || url.host == "localhost" else {
            reply(requestID, to: webView, error: "不支持打开此网页")
            return
        }
        NSWorkspace.shared.open(url)
        reply(requestID, to: webView, value: ["opened": true])
    }

    private func performAPIRequest(_ input: [String: Any], path: String, requestID: String, webView: WKWebView) {
        if path == "native:cancel" {
            if let body = input["body"] as? [String: Any], let id = body["requestId"] as? String { requestTasks.removeValue(forKey: id)?.cancel() }
            return
        }
        if path == "/auth/login" {
            login(input, requestID: requestID, webView: webView)
            return
        }
        guard token != nil else {
            reply(requestID, to: webView, error: "尚未连接 PanWatch，请重新登录")
            return
        }
        let method = (input["method"] as? String ?? "GET").uppercased()
        guard DesktopRoutePolicy.allows(path, method: method) else {
            reply(requestID, to: webView, error: "此功能尚未开放")
            return
        }
        guard let url = URL(string: server + "/api" + path) else {
            reply(requestID, to: webView, error: "服务地址无效")
            return
        }
        var request = URLRequest(url: url, timeoutInterval: min(120, max(1, (input["timeoutMs"] as? Double ?? 20000) / 1000)))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let body = input["body"], ["POST", "PUT", "PATCH", "DELETE"].contains(method) {
            do { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
            catch { reply(requestID, to: webView, error: "请求内容无法读取"); return }
        }
        perform(request, path: path, requestID: requestID, webView: webView, login: false)
    }

    private func login(_ input: [String: Any], requestID: String, webView: WKWebView) {
        guard let candidate = input["server"] as? String, let cleanServer = normalizeServer(candidate),
              let body = input["body"] as? [String: Any],
              let username = body["username"] as? String,
              let password = body["password"] as? String else {
            reply(requestID, to: webView, error: "请输入有效的 PanWatch 服务地址、用户名和密码")
            return
        }
        let remember = body["remember_session"] as? Bool ?? false
        guard let probeURL = URL(string: cleanServer + "/api/auth/status") else {
            reply(requestID, to: webView, error: "服务地址无效")
            return
        }
        var probe = URLRequest(url: probeURL, timeoutInterval: 10)
        probe.setValue("application/json", forHTTPHeaderField: "Accept")
        session.dataTask(with: probe) { [weak self] data, response, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let error { self.reply(requestID, to: webView, error: error.localizedDescription); return }
                do {
                    try APIResponse.validateService(data, response: response)
                    var request = URLRequest(url: URL(string: cleanServer + "/api/auth/login")!, timeoutInterval: 20)
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "Accept")
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.httpBody = try JSONSerialization.data(withJSONObject: ["username": username, "password": password])
                    self.performLogin(request, cleanServer: cleanServer, remember: remember, requestID: requestID, webView: webView)
                } catch { self.reply(requestID, to: webView, error: error.localizedDescription) }
            }
        }.resume()
    }

    private func performLogin(_ request: URLRequest, cleanServer: String, remember: Bool, requestID: String, webView: WKWebView) {
        session.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            DispatchQueue.main.async {
                if let error { self.reply(requestID, to: webView, error: error.localizedDescription); return }
                do {
                    let result = try APIResponse.decode(data, response: response, login: true)
                    guard let login = result as? [String: Any], let token = login["token"] as? String, !token.isEmpty else {
                        throw APIResponseError(message: "登录接口未返回有效凭证，请检查 PanWatch 服务版本")
                    }
                    self.clearSession(removeSaved: false)
                    self.server = cleanServer
                    self.token = token
                    self.defaults.set(cleanServer, forKey: "server")
                    self.defaults.set(remember, forKey: "rememberSession")
                    if remember {
                        guard self.keychain.save(token, server: cleanServer) else {
                            self.token = nil
                            throw APIResponseError(message: "无法将登录凭证保存到 macOS 钥匙串，请取消“保持登录”后重试")
                        }
                    } else {
                        self.keychain.delete(server: cleanServer)
                    }
                    self.configureNotifications()
                    self.setNotificationBaseline()
                    self.reply(requestID, to: webView, value: ["connected": true])
                } catch { self.reply(requestID, to: webView, error: error.localizedDescription) }
            }
        }.resume()
    }

    private func setNotificationBaseline() {
        backgroundGET("/notifications/summary") { [weak self] result in
            guard let self, case .success(let data) = result,
                  let summary = data as? [String: Any], let observed = summary["observed_id"] as? Int64 else { return }
            let key = "notificationCursor:\(self.server)"
            if self.defaults.object(forKey: key) == nil { self.defaults.set(observed, forKey: key) }
        }
    }

    private func perform(_ request: URLRequest, path: String, requestID: String, webView: WKWebView, login: Bool) {
        let task = session.dataTask(with: request) { [weak self, weak webView] data, response, error in
            guard let self, let webView else { return }
            DispatchQueue.main.async {
                self.requestTasks.removeValue(forKey: requestID)
                if let error { self.reply(requestID, to: webView, error: error.localizedDescription); return }
                if (response as? HTTPURLResponse)?.statusCode == 401 && !login {
                    self.clearSession(removeSaved: true)
                    self.mainWeb.evaluateJavaScript("window.dispatchEvent(new Event('panwatch:session-expired'))", completionHandler: nil)
                }
                do {
                    let result = try APIResponse.decode(data, response: response, login: login)
                    self.reply(requestID, to: webView, value: result)
                } catch { self.reply(requestID, to: webView, error: error.localizedDescription) }
            }
        }
        requestTasks[requestID] = task
        task.resume()
    }

    private func reply(_ requestID: String, to webView: WKWebView, value: Any = NSNull(), error: String? = nil) {
        var payload: [String: Any] = ["id": requestID, "value": value]
        payload["error"] = error.map { $0 as Any } ?? NSNull()
        guard let bytes = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: bytes, encoding: .utf8) else { return }
        let encoded = Data(json.utf8).base64EncodedString()
        webView.evaluateJavaScript("window.receive(window.__panWatchDecode('\(encoded)'))", completionHandler: nil)
    }

    private func broadcastSnapshot() {
        guard let snapshot = latestSnapshot,
              let bytes = try? JSONSerialization.data(withJSONObject: snapshot),
              let json = String(data: bytes, encoding: .utf8) else { return }
        let encoded = Data(json.utf8).base64EncodedString()
        miniWeb?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('panwatch:snapshot',{detail:window.__panWatchDecode('\(encoded)')}))", completionHandler: nil)
    }

    private func updateMenuSummary(_ values: [String: Any]) {
        let title = values["title"] as? String ?? "PanWatch · 盯盘"
        let subtitle = values["subtitle"] as? String ?? ""
        summaryMenuItem?.title = privacyMode ? "PanWatch · 隐私模式" : [title, subtitle].filter { !$0.isEmpty }.joined(separator: "　")
    }

    private func normalizeServer(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              components.user == nil, components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil, components.fragment == nil else { return nil }
        let isLocal = ["localhost", "127.0.0.1", "::1"].contains(host)
        guard scheme == "https" || (scheme == "http" && isLocal) else { return nil }
        let normalizedHost = host == "::1" ? "[::1]" : host
        return "\(scheme)://\(normalizedHost)" + (components.port.map { ":\($0)" } ?? "")
    }

    private func normalizedPort(_ url: URL) -> Int { url.port ?? (url.scheme == "https" ? 443 : 80) }

}
