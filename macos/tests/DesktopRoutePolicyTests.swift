import Foundation

@main
struct DesktopRoutePolicyTests {
    static func main() {
        precondition(DesktopRoutePolicy.allows("/portfolio/summary?include_quotes=true&refresh_exchange_rates=true", method: "GET"))
        precondition(DesktopRoutePolicy.allows("/stocks/reorder", method: "PUT"))
        precondition(DesktopRoutePolicy.allows("/quotes/batch", method: "POST"))
        precondition(!DesktopRoutePolicy.allows("/quotes/batch", method: "GET"))
        precondition(DesktopRoutePolicy.allows("/watch-groups/3?version=2", method: "DELETE"))
        precondition(DesktopRoutePolicy.allows("/watch-groups/3/members", method: "PUT"))
        precondition(DesktopRoutePolicy.allows("/price-alerts/12/toggle", method: "POST"))
        precondition(DesktopRoutePolicy.allows("/recommendations/strategy-signals?market=CN&status=active&holding=all&limit=100", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("/recommendations/strategy-signals?market=CN&next=https://evil.example", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("/recommendations/strategy-signals?market=CN&status=active&holding=all&limit=500", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("https://evil.example/api/stocks", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("/stocks?next=https://evil.example", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("/portfolio/summary?token=secret", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("/watch-groups/../stocks", method: "GET"))
        precondition(!DesktopRoutePolicy.allows("/stocks", method: "DELETE"))
        print("Desktop route allowlist checks passed")
    }
}
