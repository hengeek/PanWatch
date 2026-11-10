import Foundation

enum DesktopRoutePolicy {
    static func allows(_ route: String, method rawMethod: String) -> Bool {
        guard route.hasPrefix("/"), !route.hasPrefix("//"), !route.contains("\\"),
              !route.contains(".."), !route.contains("://") else { return false }
        let method = rawMethod.uppercased()
        guard let components = URLComponents(string: route), components.scheme == nil, components.host == nil else { return false }
        let path = components.path
        let queryItems = components.queryItems ?? []
        if path == "/recommendations/strategy-signals" {
            guard queryItems.count == 4,
                  Set(queryItems.map(\.name)) == Set(["market", "status", "holding", "limit"]) else { return false }
            let values = Dictionary(uniqueKeysWithValues: queryItems.compactMap { item in item.value.map { (item.name, $0) } })
            guard method == "GET",
                  values["market"].map(["CN", "HK", "US"].contains) == true,
                  values["status"] == "active",
                  values["holding"] == "all",
                  let limit = Int(values["limit"] ?? ""), (1...100).contains(limit) else { return false }
            return true
        }
        let allowedParameters: [String: Set<String>] = [
            "/portfolio/summary": ["include_quotes", "refresh_exchange_rates", "account_id"],
            "/notifications": ["view", "limit", "cursor"],
            "/portfolio/attribution": ["days"],
            "/portfolio/benchmark": ["days", "benchmark"],
        ]
        if let keys = allowedParameters[path] {
            guard queryItems.allSatisfy({ keys.contains($0.name) }), Set(queryItems.map(\.name)).count == queryItems.count else { return false }
        } else if !queryItems.isEmpty {
            let isGroupDelete = path.range(of: #"^/watch-groups/[0-9]+$"#, options: .regularExpression) != nil && method == "DELETE"
            guard isGroupDelete,
                  queryItems.count == 1,
                  queryItems[0].name == "version",
                  Int(queryItems[0].value ?? "") ?? 0 > 0 else { return false }
        }
        let exact: [String: Set<String>] = [
            "/auth/status": ["GET"], "/stocks": ["GET"], "/stocks/reorder": ["PUT"], "/portfolio/summary": ["GET"],
            "/stocks/markets/status": ["GET"], "/quotes/batch": ["POST"],
            "/notifications/summary": ["GET"], "/notifications": ["GET"],
            "/notifications/read": ["POST"], "/price-alerts": ["GET", "POST"],
            "/channels": ["GET"], "/portfolio/diagnostics": ["GET"],
            "/portfolio/attribution": ["GET"], "/portfolio/benchmark": ["GET"],
            "/portfolio/ai-review": ["POST"], "/insights/batch": ["POST"],
            "/watch-groups": ["GET", "POST"], "/watch-groups/order": ["PUT"],
            "/watch-groups/members": ["PUT"],
        ]
        if exact[path]?.contains(method) == true {
            if path == "/notifications" {
                return queryItems.allSatisfy { item in
                    if item.name == "view" { return item.value == "all" }
                    if item.name == "limit" { return Int(item.value ?? "") != nil }
                    return item.name == "cursor" && !(item.value ?? "").isEmpty
                }
            }
            if path == "/portfolio/summary" {
                return queryItems.allSatisfy { item in
                    if item.name == "include_quotes" || item.name == "refresh_exchange_rates" { return ["true", "false"].contains(item.value ?? "") }
                    return item.name == "account_id" && Int(item.value ?? "") != nil
                }
            }
            return true
        }
        if path.range(of: #"^/klines/[A-Za-z0-9._-]+$"#, options: .regularExpression) != nil {
            return method == "GET" && queryItems.count <= 3 && queryItems.allSatisfy { ["market", "days", "interval"].contains($0.name) }
        }
        if path.range(of: #"^/notifications/[0-9]+/target$"#, options: .regularExpression) != nil { return method == "GET" }
        if path.range(of: #"^/price-alerts/[0-9]+$"#, options: .regularExpression) != nil { return ["PUT", "DELETE"].contains(method) }
        if path.range(of: #"^/price-alerts/[0-9]+/toggle$"#, options: .regularExpression) != nil { return method == "POST" }
        if path.range(of: #"^/watch-groups/[0-9]+$"#, options: .regularExpression) != nil { return ["PATCH", "DELETE"].contains(method) }
        if path.range(of: #"^/watch-groups/[0-9]+/members$"#, options: .regularExpression) != nil { return method == "PUT" }
        return false
    }
}
