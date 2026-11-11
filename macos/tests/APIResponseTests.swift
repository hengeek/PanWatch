import Foundation

@main
struct APIResponseTests {
    static func response(_ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "http://127.0.0.1:8000/api/auth/status")!, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
    static func data(_ text: String) -> Data { Data(text.utf8) }
    static func fails(_ expected: String, _ body: () throws -> Void) {
        do { try body(); fatalError("Expected failure: \(expected)") }
        catch { precondition(error.localizedDescription.contains(expected), error.localizedDescription) }
    }
    static func main() async throws {
        try APIResponse.validateService(data(#"{"code":0,"success":true,"data":{"initialized":true}}"#), response: response(200))
        fails("其他应用的端口") { try APIResponse.validateService(data("<!DOCTYPE html><title>LingOps</title>"), response: response(200)) }
        fails("尚未创建账号") { try APIResponse.validateService(data(#"{"code":0,"data":{"initialized":false}}"#), response: response(200)) }
        fails("不是可识别") { try APIResponse.validateService(data(#"{"code":0,"data":{"status":"ok"}}"#), response: response(200)) }
        fails("用户名或密码不正确") { _ = try APIResponse.decode(data(#"{"detail":"Unauthorized"}"#), response: response(401), login: true) }
        fails("登录已失效") { _ = try APIResponse.decode(nil, response: response(401)) }
        fails("HTTP 502") { _ = try APIResponse.decode(data("<html>Bad Gateway</html>"), response: response(502)) }
        fails("服务维护中") { _ = try APIResponse.decode(data(#"{"code":1,"data":null,"message":"服务维护中"}"#), response: response(200)) }
        print("8 response validation checks passed")
        if CommandLine.arguments.contains("--live") {
            for port in [8000, 8080] {
                let (body, response) = try await URLSession.shared.data(from: URL(string: "http://127.0.0.1:\(port)/api/auth/status")!)
                if port == 8000 {
                    try APIResponse.validateService(body, response: response)
                    print("Live :8000 identified as initialized PanWatch")
                } else {
                    fails("其他应用的端口") { try APIResponse.validateService(body, response: response) }
                    print("Live :8080 rejected before submitting credentials")
                }
            }
        }
    }
}
