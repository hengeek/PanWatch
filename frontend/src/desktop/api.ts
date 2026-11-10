import type { PanWatchDesktopBridge } from '@panwatch/api/client'
import type { WatchGroup } from '@panwatch/api/watch-groups'

export type DesktopBridge = PanWatchDesktopBridge
const bridge = () => {
  if (!window.panWatchDesktop) throw new Error('请从 PanWatch macOS 应用中打开桌面页面。')
  return window.panWatchDesktop
}

export const desktopApi = {
  config: () => bridge().request('native:config') as Promise<DesktopConfig>,
  connect: (server: string, username: string, password: string, rememberSession: boolean) =>
    bridge().request('/auth/login', { username, password, remember_session: rememberSession }, server) as Promise<{ connected: boolean }>,
  restoreSession: () => bridge().request('native:session-restore') as Promise<{ connected: boolean }>,
  logout: () => bridge().request('native:logout'),
  preferences: (patch: Partial<DesktopConfig>) => bridge().request('native:preferences', patch),
  nativeWindow: (mode: 'main' | 'mini') => bridge().request(`native:window:${mode}`),
  enableNotifications: (enabled: boolean) => bridge().request('native:notifications', { enabled }),
  setMenuSummary: (value: { title: string; subtitle: string }) => bridge().request('native:menu-summary', value),
  publishSnapshot: (value: Record<string, unknown>) => bridge().request('native:snapshot', value),
  selectStock: (key: string) => bridge().request('native:select-stock', { key }),
  stocks: () => bridge().request('/stocks') as Promise<Stock[]>,
  reorderStocks: (items: Array<{ id: number; sort_order: number }>) => bridge().request('/stocks/reorder', { items }, undefined, 'PUT') as Promise<{ updated: number }>,
  portfolio: () => bridge().request('/portfolio/summary?include_quotes=true&refresh_exchange_rates=true') as Promise<Portfolio>,
  quotes: (items: Array<{ symbol: string; market: string }>) =>
    bridge().request('/quotes/batch', { items }) as Promise<Quote[]>,
  markets: () => bridge().request('/stocks/markets/status') as Promise<Market[]>,
  klines: (symbol: string, market: string, days = 20, signal?: AbortSignal) => bridge().request('/klines/' + encodeURIComponent(symbol) + `?market=${encodeURIComponent(market)}&days=${days}&interval=1d`, undefined, undefined, 'GET', { signal }) as Promise<KlineResponse>,
  openWeb: (route: '/' | '/portfolio' | '/alerts' | '/assistant' | '/opportunities' | '/history') => bridge().request(`open-web:${route}`),
  notificationSummary: () => bridge().request('/notifications/summary') as Promise<NotificationSummary>,
  notifications: (cursor?: string) => bridge().request('/notifications?view=all&limit=100' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')) as Promise<NotificationPage>,
  notificationRead: (id: number) => bridge().request('/notifications/read', { ids: [id] }, undefined, 'POST') as Promise<{ updated: number }>,
  notificationTarget: (id: number) => bridge().request(`/notifications/${id}/target`) as Promise<NotificationTarget>,
  groups: async () => (await bridge().request('/watch-groups') as { items: WatchGroup[] }).items,
  createGroup: (name: string) => bridge().request('/watch-groups', { name }, undefined, 'POST') as Promise<WatchGroup>,
  setGroupOrder: (items: Array<{ group_id: number; sort_order: number; version: number }>) => bridge().request('/watch-groups/order', { items }, undefined, 'PUT') as Promise<{ items: WatchGroup[] }>,
  setGroupsMembers: (groups: Array<{ group_id: number; stock_ids: number[]; version: number }>) => bridge().request('/watch-groups/members', { groups }, undefined, 'PUT') as Promise<{ items: WatchGroup[] }>,
  renameGroup: (group: WatchGroup, name: string) => bridge().request(`/watch-groups/${group.id}`, { name, version: group.version }, undefined, 'PATCH') as Promise<WatchGroup>,
  deleteGroup: (group: WatchGroup) => bridge().request(`/watch-groups/${group.id}?version=${group.version}`, undefined, undefined, 'DELETE'),
  alertRules: () => bridge().request('/price-alerts') as Promise<AlertRule[]>,
  channels: () => bridge().request('/channels') as Promise<Array<{ id: number; name: string; enabled: boolean }>>,
  portfolioDiagnostics: () => bridge().request('/portfolio/diagnostics') as Promise<PortfolioDiagnostics>,
  portfolioAttribution: (days = 60) => bridge().request(`/portfolio/attribution?days=${days}`) as Promise<{ items: AttributionItem[] }>,
  portfolioBenchmark: (days = 60) => bridge().request(`/portfolio/benchmark?days=${days}&benchmark=000300`) as Promise<PortfolioBenchmark>,
  portfolioAiReview: () => bridge().request('/portfolio/ai-review', {}, undefined, 'POST') as Promise<PortfolioAiReview>,
  stockInsight: (symbol: string, market: string, signal?: AbortSignal) => bridge().request('/insights/batch', { items: [{ symbol, market }] }, undefined, 'POST', { signal }) as Promise<Insight[]>,
  strategySignals: (market: string, signal?: AbortSignal) => bridge().request(
    `/recommendations/strategy-signals?market=${encodeURIComponent(market)}&status=active&holding=all&limit=100`,
    undefined,
    undefined,
    'GET',
    { signal, timeoutMs: 15000 },
  ) as Promise<StrategySignalsResponse>,
  setPrivacy: (hidden: boolean) => bridge().configurePrivacy?.(hidden),
}

export interface DesktopConfig {
  server: string
  privacy: boolean
  autoRefresh: boolean
  refreshInterval: number
  rememberSession: boolean
  sessionAvailable: boolean
  visibleColumns: string[]
  notificationsEnabled: boolean
  hotkeyEnabled: boolean
  hotkeyStatus: 'enabled' | 'conflict' | 'disabled' | 'unsupported'
  launchAtLogin: boolean
  miniAlwaysOnTop: boolean
  hideNotificationAmounts: boolean
}
export interface Stock { id: number; symbol: string; name: string; market: string; asset_type?: string; sort_order?: number; agents?: Array<{ agent_name: string; schedule?: string }> }
export interface Quote { symbol: string; market: string; current_price: number | null; prev_close?: number | null; change_pct: number | null; daily_move_status?: string; quote_date?: string | null }
export interface Market { code: string; name: string; status: string; status_text: string; local_date?: string; local_time?: string }
export interface Position {
  id: number; stock_id: number; symbol: string; name: string; market: string; cost_price: number; quantity: number;
  current_price: number | null; market_value_cny: number | null; pnl: number | null; daily_pnl: number | null;
  pnl_pct: number | null; change_pct: number | null; daily_move_status?: string; quote_date?: string | null
}
export interface Account {
  id: number; name: string; total_market_value: number; total_pnl: number; total_daily_pnl: number;
  total_assets: number; positions: Position[]
}
export interface Portfolio { accounts: Account[]; total: { total_market_value: number; total_pnl: number; total_daily_pnl: number; total_assets: number }; exchange_rates?: { HKD_CNY?: number | null; USD_CNY?: number | null } }
export interface KlineResponse { klines: Array<{ date: string; close: number; open?: number; high?: number; low?: number; volume?: number }> }
export interface NotificationSummary { unread_count: number; pending_action_count: number; observed_id: number }
export interface NotificationItem { id: number; source: string; event_type: string; severity: string; title: string; template_key: string; template_params: Record<string, string | number | null>; occurred_at: string; read_at: string | null; archived_at: string | null; toast_eligible: boolean; action_required: boolean; available: boolean; actions: Array<Record<string, unknown>> }
export interface NotificationPage { items: NotificationItem[]; next_cursor: string | null; observed_id: number }
export interface NotificationTarget { kind: string; id?: number; symbol?: string; rule_id?: number; conversation_id?: number; export_id?: number; agent_name?: string; result?: string; error?: string }
export interface AlertRule { id: number; stock_id: number; stock_symbol: string; stock_name: string; market: string; name: string; enabled: boolean; condition_group: { op: 'and' | 'or'; items: Array<{ type: string; op: string; value: number | number[] }> }; market_hours_mode: string; cooldown_minutes: number; max_triggers_per_day: number; repeat_mode: string; expire_at: string | null; notify_channel_ids: number[]; last_trigger_at: string | null }
export interface PortfolioDiagnostics { position_count: number; total_market_value: number; hhi: number; max_weight: number; by_market: Record<string, number>; by_strategy: Record<string, number>; total_unrealized_pnl: number; alerts: string[]; alert_details?: Array<{ code: string; weight?: number; hhi?: number; count?: number; market?: string }> }
export interface AttributionItem { symbol: string; name: string; market: string; return_pct: number; weight_pct: number; contribution_pct: number }
export interface PortfolioBenchmark { empty?: boolean; reason?: string; portfolio_return?: number; benchmark_return?: number; excess_return?: number; information_ratio?: number; relative_drawdown?: number; days?: number; benchmark_label?: string; curve?: Array<{ date: string; portfolio: number; benchmark: number }> }
export interface PortfolioAiReview { empty?: boolean; reason?: string; content?: string; top?: AttributionItem[]; worst?: AttributionItem[] }
export interface Insight { symbol: string; market: string; quote: Record<string, unknown>; kline_summary: Record<string, unknown>; suggestion: Record<string, unknown> | null }
export interface StrategySignalSummary { id: number; snapshot_date: string; stock_symbol: string; stock_market: string; stock_name: string; strategy_name: string; risk_level_label: string; action_label: string; signal: string; reason: string; source_pool_label: string; status: string }
export interface StrategySignalsResponse { snapshot_date: string; count: number; items: StrategySignalSummary[] }
