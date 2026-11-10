import Foundation

struct APIResponseError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum APIResponse {
    static func decode(_ data: Data?, response: URLResponse?, login: Bool = false) throws -> Any {
        guard let http = response as? HTTPURLResponse else {
            throw APIResponseError(message: "未收到服务响应，请检查服务是否启动")
        }
        let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        guard (200..<300).contains(http.statusCode) else {
            let message: String
            if http.statusCode == 401 {
                message = login ? "用户名或密码不正确" : "登录已失效，请重新连接"
            } else {
                message = (json?["message"] as? String) ?? (json?["detail"] as? String) ?? "服务请求失败"
            }
            throw APIResponseError(message: "\(message)（HTTP \(http.statusCode)）")
        }
        guard let json, let code = json["code"] as? Int, json.keys.contains("data") else {
            throw APIResponseError(message: "该地址未返回 PanWatch 接口数据，可能填入了其他应用的端口。本机 PanWatch 通常为 http://127.0.0.1:8000")
        }
        guard code == 0, (json["success"] as? Bool) != false else {
            throw APIResponseError(message: (json["message"] as? String) ?? "服务请求失败")
        }
        return json["data"] ?? NSNull()
    }

    static func validateService(_ data: Data?, response: URLResponse?) throws {
        let result = try decode(data, response: response)
        guard let status = result as? [String: Any], let initialized = status["initialized"] as? Bool else {
            throw APIResponseError(message: "该地址不是可识别的 PanWatch 服务，请检查服务地址和端口")
        }
        guard initialized else {
            throw APIResponseError(message: "PanWatch 尚未创建账号，请先在网页中完成账号设置")
        }
    }
}
