export interface DesktopBridge {
  request(path: string, body?: unknown, server?: string, method?: string): Promise<unknown>
  configurePrivacy?(hidden: boolean): void
}

declare global {
  interface Window { panWatchDesktop?: DesktopBridge }
}

import type { WatchGroup } from '@panwatch/api/watch-groups'

const bridge = () => {
  if (!window.panWatchDesktop) throw new Error('请从 PanWatch macOS 应用中打开桌面页面。')
  return window.panWatchDesktop
}

export const desktopApi = {
  config: () => bridge().request('config') as Promise<{ server: string }>,
  connect: (server: string, username: string, password: string) =>
    bridge().request('/auth/login', { username, password }, server) as Promise<{ connected: boolean }>,
  stocks: () => bridge().request('/stocks') as Promise<Stock[]>,
  portfolio: () => bridge().request('/portfolio/summary?include_quotes=true&refresh_exchange_rates=true') as Promise<Portfolio>,
  quotes: (items: Array<{ symbol: string; market: string }>) =>
    bridge().request('/quotes/batch', { items }) as Promise<Quote[]>,
  markets: () => bridge().request('/stocks/markets/status') as Promise<Market[]>,
  klines: (symbol: string, market: string) => bridge().request('/klines/' + encodeURIComponent(symbol) + `?market=${encodeURIComponent(market)}&days=20&interval=1d`) as Promise<KlineResponse>,
  openWeb: (route: '/' | '/portfolio' | '/alerts' | '/assistant') => bridge().request(`open-web:${route}`),
  notificationSummary: () => bridge().request('/notifications/summary') as Promise<{ unread_count: number; pending_action_count: number }>,
  groups: async () => (await bridge().request('/watch-groups') as { items: WatchGroup[] }).items,
  createGroup: (name: string) => bridge().request('/watch-groups', { name }, undefined, 'POST') as Promise<WatchGroup>,
  setGroupsMembers: (groups: Array<{ group_id: number; stock_ids: number[]; version: number }>) => bridge().request(
    '/watch-groups/members', { groups }, undefined, 'PUT',
  ) as Promise<{ items: WatchGroup[] }>,
  renameGroup: (group: WatchGroup, name: string) => bridge().request(
    `/watch-groups/${group.id}`, { name, version: group.version }, undefined, 'PATCH',
  ) as Promise<WatchGroup>,
  deleteGroup: (group: WatchGroup) => bridge().request(`/watch-groups/${group.id}?version=${group.version}`, undefined, undefined, 'DELETE'),
  setPrivacy: (hidden: boolean) => bridge().configurePrivacy?.(hidden),
}

export interface Stock { id: number; symbol: string; name: string; market: string; asset_type?: string }
export interface Quote { symbol: string; market: string; current_price: number | null; change_pct: number | null; daily_move_status?: string; quote_date?: string | null }
export interface Market { code: string; name: string; status: string; status_text: string; local_date?: string; local_time?: string }
export interface Position {
  id: number; stock_id: number; symbol: string; name: string; market: string; cost_price: number; quantity: number;
  current_price: number | null; market_value_cny: number | null; pnl: number | null; daily_pnl: number | null;
  pnl_pct: number | null; change_pct: number | null; daily_move_status?: string; quote_date?: string | null;
}
export interface Account {
  id: number; name: string; total_market_value: number; total_pnl: number; total_daily_pnl: number;
  total_assets: number; positions: Position[];
}
export interface Portfolio { accounts: Account[]; total: { total_market_value: number; total_pnl: number; total_daily_pnl: number; total_assets: number }; exchange_rates?: { HKD_CNY?: number | null; USD_CNY?: number | null } }
export interface KlineResponse { klines: Array<{ date: string; close: number }> }
