import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Activity, ArrowDown, ArrowUp, Bell, BellRing, ChevronDown, Clock3, Eye, EyeOff, ExternalLink, FolderPlus, LayoutDashboard, LineChart, ListFilter, LockKeyhole, Menu, MoreHorizontal, RefreshCw, Search, Settings2, TrendingUp, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@panwatch/base-ui/components/ui/confirm-dialog'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@panwatch/base-ui/components/ui/dialog'
import { useToast } from '@panwatch/base-ui/components/ui/toast'
import StockPriceAlertPanel from '@panwatch/biz-ui/components/stock-price-alert-panel'
import { desktopApi, type Account, type AttributionItem, type DesktopConfig, type Insight, type KlineResponse, type Market, type NotificationItem, type NotificationPage, type Portfolio, type PortfolioAiReview, type PortfolioBenchmark, type PortfolioDiagnostics, type Position, type Quote, type Stock, type StrategySignalSummary } from './api'
import type { WatchGroup } from '@panwatch/api/watch-groups'

 type Page = 'watch' | 'messages' | 'portfolio'
type SortKey = 'manual' | 'name' | 'price' | 'change' | 'pnl' | 'weight'
type SortDirection = 'asc' | 'desc'
type ColumnKey = 'daily' | 'cost' | 'shares' | 'weight'
type PositionRow = Position & { accountId: number; accountName: string; stock: Stock }
type DisplayRow = {
  key: string
  stock: Stock
  market: string
  accountId: number | null
  accountName: string
  price: number | null
  change: number | null
  pnl: number | null
  dailyPnl: number | null
  pnlPct: number | null
  cost: number | null
  shares: number | null
  cnyValue: number | null
  weight: number | null
}
type MiniSnapshot = { privacy: boolean; updated: string; rows: Array<{ key: string; name: string; symbol: string; market: string; price: number | null; change: number | null; pnl: number | null }> }

const marketCode = (market: string) => market.toUpperCase()
const currencyFor = (market: string) => market === 'US' ? 'USD' : market === 'HK' ? 'HKD' : 'CNY'
const numberText = (value: number | null | undefined, locale: string, digits = 2) => value == null || !Number.isFinite(value)
  ? '—'
  : new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
const signedPercent = (value: number | null | undefined, locale: string) => value == null ? '—' : `${value > 0 ? '+' : ''}${numberText(value, locale)}%`
const tone = (value: number | null | undefined) => value == null || value === 0 ? 'flat' : value > 0 ? 'gain' : 'loss'
const keyFor = (market: string, symbol: string) => `${marketCode(market)}:${symbol}`
const validToday = (quote: Quote | undefined, market: Market | undefined) => !!quote && quote.daily_move_status === 'current' && market?.status === 'trading' && (!quote.quote_date || quote.quote_date === market.local_date)
const currencyText = (value: number | null | undefined, locale: string, currency = 'CNY') => value == null
  ? '—'
  : new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(value)

export default function DesktopApp() {
  const { t } = useTranslation('desktop')
  const tr = useCallback((key: string, options?: Record<string, unknown>) => (t as unknown as (path: string, opts?: Record<string, unknown>) => string)(key, options), [t])
  const showConfirm = useConfirm()
  const { toast } = useToast()
  const isMiniWindow = useMemo(() => new URLSearchParams(window.location.search).get('mode') === 'mini', [])
  const locale = document.documentElement.lang || navigator.language || 'zh-CN'

  const [config, setConfig] = useState<DesktopConfig | null>(null)
  const [server, setServer] = useState('http://127.0.0.1:8000')
  const [connected, setConnected] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [rememberSession, setRememberSession] = useState(false)
  const [loginError, setLoginError] = useState('')
  const [loginBusy, setLoginBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<Page>('watch')
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [watchGroups, setWatchGroups] = useState<WatchGroup[]>([])
  const [groupsReady, setGroupsReady] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [markets, setMarkets] = useState<Record<string, Market>>({})
  const [selection, setSelection] = useState('all')
  const [selectedKey, setSelectedKey] = useState('')
  const [query, setQuery] = useState('')
  const [unreadCount, setUnreadCount] = useState(0)
  const [pendingCount, setPendingCount] = useState(0)
  const [lastUpdated, setLastUpdated] = useState('')
  const [privacy, setPrivacy] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [refreshInterval, setRefreshInterval] = useState(30)
  const [detailKlines, setDetailKlines] = useState<KlineResponse | null>(null)
  const [detailInsight, setDetailInsight] = useState<Insight | null>(null)
  const [detailStrategySignals, setDetailStrategySignals] = useState<StrategySignalSummary[]>([])
  const [detailStrategyBusy, setDetailStrategyBusy] = useState(false)
  const [detailBusy, setDetailBusy] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('manual')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const [columns, setColumns] = useState<ColumnKey[]>(['daily', 'weight'])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [groupCreateOpen, setGroupCreateOpen] = useState(false)
  const [groupManageOpen, setGroupManageOpen] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [renameTarget, setRenameTarget] = useState<WatchGroup | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [memberOpen, setMemberOpen] = useState(false)
  const [memberSelections, setMemberSelections] = useState<number[]>([])
  const [groupBusy, setGroupBusy] = useState(false)
  const [columnOpen, setColumnOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [notificationCursor, setNotificationCursor] = useState<string | null>(null)
  const [notificationsBusy, setNotificationsBusy] = useState(false)
  const [portfolioDiagnostics, setPortfolioDiagnostics] = useState<PortfolioDiagnostics | null>(null)
  const [portfolioAttribution, setPortfolioAttribution] = useState<AttributionItem[]>([])
  const [portfolioBenchmark, setPortfolioBenchmark] = useState<PortfolioBenchmark | null>(null)
  const [portfolioAiReview, setPortfolioAiReview] = useState<PortfolioAiReview | null>(null)
  const [portfolioBusy, setPortfolioBusy] = useState(false)
  const [aiReviewBusy, setAiReviewBusy] = useState(false)
  const [miniSnapshot, setMiniSnapshot] = useState<MiniSnapshot | null>(null)

  const refreshInFlight = useRef(false)
  const refreshFailures = useRef(0)
  const accountRows: PositionRow[] = useMemo(() => (portfolio?.accounts ?? []).flatMap(account => (account.positions ?? []).map(position => ({
    ...position,
    accountId: account.id,
    accountName: account.name,
    stock: { id: position.stock_id, symbol: position.symbol, name: position.name, market: position.market },
  }))), [portfolio])
  const accountPositionKeys = useMemo(() => new Set(accountRows.map(position => keyFor(position.market, position.symbol))), [accountRows])
  const accountMap = useMemo(() => Object.fromEntries((portfolio?.accounts ?? []).map(account => [String(account.id), account])), [portfolio])
  const selectedCustomGroup = selection.startsWith('custom:') ? watchGroups.find(group => String(group.id) === selection.slice('custom:'.length)) : undefined
  const isWatch = selection === 'watch' || selection.startsWith('market:') || selection.startsWith('custom:')
  const selectedWatchMarket = selection.startsWith('market:') ? selection.slice('market:'.length) : ''
  const selectedGroupStockIds = useMemo(() => new Set(selectedCustomGroup?.members.map(member => member.stock_id) ?? []), [selectedCustomGroup])
  const unheldStocks = stocks.filter(stock => !accountPositionKeys.has(keyFor(stock.market, stock.symbol)))
  const activeMarket = Object.values(markets).find(market => market.status === 'trading')

  const reloadGroups = useCallback(async () => {
    try {
      const groups = await desktopApi.groups()
      setWatchGroups(groups)
      setGroupsReady(true)
      return groups
    } catch {
      setGroupsReady(false)
      return null
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!connected || refreshInFlight.current || isMiniWindow) return
    refreshInFlight.current = true
    setRefreshing(true)
    try {
      const [nextPortfolio, nextStocks, nextMarkets, summary, groupsResult] = await Promise.all([
        desktopApi.portfolio(),
        desktopApi.stocks(),
        desktopApi.markets(),
        desktopApi.notificationSummary().catch(() => ({ unread_count: 0, pending_action_count: 0, observed_id: 0 })),
        desktopApi.groups().then(items => ({ items, ok: true })).catch(() => ({ items: [] as WatchGroup[], ok: false })),
      ])
      const nextQuotes: Record<string, Quote> = {}
      for (const account of nextPortfolio.accounts ?? []) {
        for (const position of account.positions ?? []) {
          nextQuotes[keyFor(position.market, position.symbol)] = {
            symbol: position.symbol,
            market: position.market,
            current_price: position.current_price,
            change_pct: position.change_pct,
            daily_move_status: position.daily_move_status,
            quote_date: position.quote_date,
          }
        }
      }
      const nextHeldKeys = new Set(nextPortfolio.accounts.flatMap(account => account.positions.map(position => keyFor(position.market, position.symbol))))
      const watchOnly = nextStocks
        .filter(stock => !nextHeldKeys.has(keyFor(stock.market, stock.symbol)))
        .map(stock => ({ market: stock.market, symbol: stock.symbol }))
      const watchQuotes = watchOnly.length ? await desktopApi.quotes(watchOnly) : []
      for (const quote of watchQuotes) nextQuotes[keyFor(quote.market, quote.symbol)] = quote
      setPortfolio(nextPortfolio)
      setStocks(nextStocks)
      setMarkets(Object.fromEntries(nextMarkets.map(market => [market.code, market])))
      setQuotes(nextQuotes)
      setUnreadCount(summary.unread_count)
      setPendingCount(summary.pending_action_count)
      setWatchGroups(groupsResult.items)
      setGroupsReady(groupsResult.ok)
      const updated = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      setLastUpdated(updated)
      setNotice('')
      refreshFailures.current = 0
      const allPnl = nextPortfolio.total?.total_pnl
      const statusName = nextMarkets.find(market => market.status === 'trading')?.name ?? tr('market.closed')
      await desktopApi.setMenuSummary({
        title: statusName,
        subtitle: privacy ? tr('privacy.hiddenSummary') : `${tr('summary.floatingPnl')} ${currencyText(allPnl, locale)}`,
      })
      const snapshot: MiniSnapshot = {
        privacy,
        updated,
        rows: nextPortfolio.accounts.flatMap(account => account.positions).slice(0, 7).map(position => ({
          key: keyFor(position.market, position.symbol),
          name: position.name,
          symbol: position.symbol,
          market: position.market,
          price: position.current_price,
          change: validToday(nextQuotes[keyFor(position.market, position.symbol)], nextMarkets.find(market => market.code === position.market)) ? position.change_pct : null,
          pnl: position.pnl,
        })),
      }
      await desktopApi.publishSnapshot(snapshot as unknown as Record<string, unknown>)
    } catch (error) {
      refreshFailures.current += 1
      const message = error instanceof Error ? error.message : tr('errors.serviceUnavailable')
      setNotice(tr('errors.refreshFailed', { message }))
      if (message.includes('重新连接') || message.includes('登录已失效')) setConnected(false)
    } finally {
      refreshInFlight.current = false
      setRefreshing(false)
    }
  }, [accountPositionKeys, connected, isMiniWindow, locale, privacy, tr])

  useEffect(() => {
    desktopApi.config().then(async next => {
      setConfig(next)
      setServer(next.server || 'http://127.0.0.1:8000')
      setPrivacy(next.privacy)
      setAutoRefresh(next.autoRefresh)
      setRefreshInterval(next.refreshInterval || 30)
      setRememberSession(next.rememberSession)
      setColumns((next.visibleColumns ?? ['daily', 'weight']).filter((column): column is ColumnKey => ['daily', 'cost', 'shares', 'weight'].includes(column)))
      if (next.sessionAvailable && next.rememberSession && !isMiniWindow) {
        try {
          const restored = await desktopApi.restoreSession()
          if (restored.connected) setConnected(true)
        } catch { /* Expired credentials return to the connection screen. */ }
      }
    }).catch(() => undefined)
  }, [isMiniWindow])

  useEffect(() => { if (connected) void refresh() }, [connected, refresh])
  useEffect(() => {
    if (!connected || !autoRefresh || isMiniWindow) return
    let timer = 0
    const schedule = () => {
      const marketOpen = Object.values(markets).some(market => market.status === 'trading')
      const base = marketOpen ? (document.visibilityState === 'visible' ? refreshInterval : 120) : 300
      const backoff = refreshFailures.current ? Math.min(300, base * (2 ** Math.min(refreshFailures.current, 4))) : base
      timer = window.setTimeout(async () => { await refresh(); schedule() }, backoff * 1000)
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [autoRefresh, connected, isMiniWindow, markets, refresh, refreshInterval])

  useEffect(() => {
    if (isMiniWindow) return
    const resume = () => void refresh()
    const privacyChange = (event: Event) => {
      const hidden = (event as CustomEvent<{ hidden: boolean }>).detail.hidden
      setPrivacy(hidden)
    }
    const selectStock = (event: Event) => {
      const key = (event as CustomEvent<{ key: string }>).detail.key
      const matching = allRows.find(row => row.key === key || row.key.startsWith(`${key}:`))
      setPage('watch')
      setSelection(matching?.accountId != null ? `account:${matching.accountId}` : 'watch')
      setSelectedKey(matching?.key ?? key)
    }
    const notification = (event: Event) => {
      const id = (event as CustomEvent<{ id: number }>).detail.id
      void openNotification(id)
    }
    const sessionExpired = () => { setConnected(false); setNotice(tr('login.failed')) }
    window.addEventListener('panwatch:resume', resume)
    window.addEventListener('panwatch:privacy', privacyChange)
    window.addEventListener('panwatch:select-stock', selectStock)
    window.addEventListener('panwatch:notification', notification)
    window.addEventListener('panwatch:session-expired', sessionExpired)
    return () => {
      window.removeEventListener('panwatch:resume', resume)
      window.removeEventListener('panwatch:privacy', privacyChange)
      window.removeEventListener('panwatch:select-stock', selectStock)
      window.removeEventListener('panwatch:notification', notification)
      window.removeEventListener('panwatch:session-expired', sessionExpired)
    }
  })

  useEffect(() => {
    if (isMiniWindow) {
      const receive = (event: Event) => setMiniSnapshot((event as CustomEvent<MiniSnapshot>).detail)
      const privacyChange = (event: Event) => setPrivacy((event as CustomEvent<{ hidden: boolean }>).detail.hidden)
      window.addEventListener('panwatch:snapshot', receive)
      window.addEventListener('panwatch:privacy', privacyChange)
      void desktopApi.miniReady().catch(() => undefined)
      desktopApi.config().then(next => setMiniSnapshot(current => current ?? ({ privacy: next.privacy, updated: '', rows: [] }))).catch(() => undefined)
      return () => { window.removeEventListener('panwatch:snapshot', receive); window.removeEventListener('panwatch:privacy', privacyChange) }
    }
    return undefined
  }, [isMiniWindow])

  useEffect(() => {
    if (connected && page === 'messages') void loadNotifications(false)
  }, [connected, page])

  const allRows: DisplayRow[] = useMemo(() => {
    const watched = stocks.filter(stock => !accountPositionKeys.has(keyFor(stock.market, stock.symbol))).map(stock => {
      const quote = quotes[keyFor(stock.market, stock.symbol)]
      return {
        key: keyFor(stock.market, stock.symbol), stock, market: stock.market,
        accountId: null, accountName: tr('groups.watch'),
        price: quote?.current_price ?? null,
        change: validToday(quote, markets[stock.market]) ? quote?.change_pct ?? null : null,
        pnl: null, dailyPnl: null, pnlPct: null, cost: null, shares: null, cnyValue: null, weight: null,
      }
    })
    const held = accountRows.map(position => {
      const quote = quotes[keyFor(position.market, position.symbol)]
      const account = accountMap[String(position.accountId)]
      return {
        key: `${keyFor(position.market, position.symbol)}:${position.accountId}`,
        stock: position.stock,
        market: position.market,
        accountId: position.accountId,
        accountName: position.accountName,
        price: quote?.current_price ?? position.current_price,
        change: validToday(quote, markets[position.market]) ? quote?.change_pct ?? null : null,
        pnl: position.pnl,
        dailyPnl: validToday(quote, markets[position.market]) ? position.daily_pnl : null,
        pnlPct: position.pnl_pct,
        cost: position.cost_price,
        shares: position.quantity,
        cnyValue: position.market_value_cny,
        weight: account?.total_market_value && position.market_value_cny != null ? position.market_value_cny / account.total_market_value * 100 : null,
      }
    })
    return [...held, ...watched]
  }, [accountMap, accountRows, markets, quotes, stocks, tr])

  const sourceRows = useMemo(() => {
    let selected: DisplayRow[]
    if (selection.startsWith('account:')) selected = allRows.filter(row => row.accountId != null && String(row.accountId) === selection.slice('account:'.length))
    else if (selection === 'all') selected = allRows.filter(row => row.accountId != null)
    else if (selection === 'watch') selected = allRows.filter(row => row.accountId == null)
    else if (selectedWatchMarket) selected = allRows.filter(row => row.accountId == null && row.market === selectedWatchMarket)
    else if (selectedCustomGroup) selected = allRows.filter(row => selectedGroupStockIds.has(row.stock.id))
    else selected = allRows.filter(row => row.accountId != null)
    if (selectedCustomGroup && sortKey === 'manual') {
      const groupOrder = new Map(selectedCustomGroup.members.map((member, index) => [member.stock_id, index]))
      selected = [...selected].sort((a, b) => (groupOrder.get(a.stock.id) ?? Number.MAX_SAFE_INTEGER) - (groupOrder.get(b.stock.id) ?? Number.MAX_SAFE_INTEGER))
    }
    const needle = query.trim().toLocaleLowerCase()
    if (needle) selected = selected.filter(row => `${row.stock.name} ${row.stock.symbol} ${row.market}`.toLocaleLowerCase().includes(needle))
    if (sortKey !== 'manual') {
      const direction = sortDirection === 'asc' ? 1 : -1
      selected = [...selected].sort((a, b) => {
        const av = sortKey === 'name' ? a.stock.name : sortKey === 'price' ? a.price : sortKey === 'change' ? a.change : sortKey === 'pnl' ? a.pnl : a.weight
        const bv = sortKey === 'name' ? b.stock.name : sortKey === 'price' ? b.price : sortKey === 'change' ? b.change : sortKey === 'pnl' ? b.pnl : b.weight
        if (typeof av === 'string' || typeof bv === 'string') return String(av ?? '').localeCompare(String(bv ?? ''), locale) * direction
        return ((av ?? Number.NEGATIVE_INFINITY) - (bv ?? Number.NEGATIVE_INFINITY)) * direction
      })
    }
    return selected
  }, [allRows, locale, query, selectedCustomGroup, selectedGroupStockIds, selectedWatchMarket, selection, sortDirection, sortKey])
  const visibleWatchRows = sourceRows.filter(row => row.accountId == null)

  const selectedRow = sourceRows.find(row => row.key === selectedKey) ?? sourceRows[0]
  const selectedQuote = selectedRow ? quotes[keyFor(selectedRow.market, selectedRow.stock.symbol)] : undefined
  const selectedMarket = selectedRow ? markets[selectedRow.market] : undefined
  const positionDetails = selectedRow ? accountRows.filter(row => keyFor(row.market, row.symbol) === keyFor(selectedRow.market, selectedRow.stock.symbol)) : []
  const groupScreenTitle = selection.startsWith('account:')
    ? accountMap[selection.slice('account:'.length)]?.name ?? tr('groups.positions')
    : selection === 'watch' ? tr('groups.watch')
      : selection.startsWith('market:') ? tr(`markets.${selectedWatchMarket}`)
        : selectedCustomGroup?.name ?? tr('groups.positions')
  const summaryAccount: Account | undefined = selection.startsWith('account:') ? accountMap[selection.slice('account:'.length)] : undefined
  const summaryValue = selection === 'all' ? portfolio?.total.total_market_value : summaryAccount?.total_market_value
  const summaryPnl = selection === 'all' ? portfolio?.total.total_pnl : summaryAccount?.total_pnl
  const summaryPositions = selection.startsWith('account:') ? accountRows.filter(row => String(row.accountId) === selection.slice('account:'.length)) : accountRows
  const summaryDailyAvailable = summaryPositions.length > 0 && summaryPositions.every(position => validToday(quotes[keyFor(position.market, position.symbol)], markets[position.market]))
  const summaryDaily = summaryDailyAvailable ? (selection === 'all' ? portfolio?.total.total_daily_pnl : summaryAccount?.total_daily_pnl) : null

  useEffect(() => {
    if (!sourceRows.some(row => row.key === selectedKey)) setSelectedKey(sourceRows[0]?.key ?? '')
  }, [selectedKey, sourceRows])

  useEffect(() => {
    if (!connected || !selectedRow || page !== 'watch' || isMiniWindow) {
      setDetailKlines(null); setDetailInsight(null); setDetailStrategySignals([]); setDetailStrategyBusy(false); return
    }
    const controller = new AbortController()
    let current = true
    setDetailKlines(null); setDetailInsight(null); setDetailStrategySignals([]); setDetailStrategyBusy(true)
    setDetailBusy(true)
    const klineRequest = desktopApi.klines(selectedRow.stock.symbol, selectedRow.market, 20, controller.signal)
      .then(value => { if (current) setDetailKlines(value) })
      .catch(() => { if (current) setDetailKlines(null) })
    const insightRequest = desktopApi.stockInsight(selectedRow.stock.symbol, selectedRow.market, controller.signal)
      .then(value => { if (current) setDetailInsight(value[0] ?? null) })
      .catch(() => { if (current) setDetailInsight(null) })
    void desktopApi.strategySignals(selectedRow.market, controller.signal)
      .then(value => {
        if (current) setDetailStrategySignals(value.items.filter(item => item.stock_market === selectedRow.market && item.stock_symbol.toUpperCase() === selectedRow.stock.symbol.toUpperCase()).slice(0, 3))
      })
      .catch(() => { if (current) setDetailStrategySignals([]) })
      .finally(() => { if (current) setDetailStrategyBusy(false) })
    Promise.allSettled([klineRequest, insightRequest]).finally(() => { if (current) setDetailBusy(false) })
    return () => { current = false; controller.abort() }
  }, [connected, isMiniWindow, page, selectedRow?.key])

  useEffect(() => {
    if (!connected || page !== 'portfolio') return
    let current = true
    setPortfolioBusy(true)
    Promise.all([
      desktopApi.portfolioDiagnostics().catch(() => null),
      desktopApi.portfolioAttribution().catch(() => ({ items: [] })),
      desktopApi.portfolioBenchmark().catch(() => null),
    ]).then(([diagnostics, attribution, benchmark]) => {
      if (!current) return
      setPortfolioDiagnostics(diagnostics)
      setPortfolioAttribution(attribution.items)
      setPortfolioBenchmark(benchmark)
    }).finally(() => { if (current) setPortfolioBusy(false) })
    return () => { current = false }
  }, [connected, page])

  useEffect(() => {
    if (isMiniWindow || !connected) return
    const listener = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'f') { event.preventDefault(); setPage('watch'); document.querySelector<HTMLInputElement>('.search-field input')?.focus() }
      if (event.key.toLowerCase() === 'k') { event.preventDefault(); setQuery(''); setPage('watch'); setSelection('all') }
    }
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [connected, isMiniWindow])

  const loadNotifications = async (append: boolean) => {
    setNotificationsBusy(true)
    try {
      const next: NotificationPage = await desktopApi.notifications(append ? notificationCursor ?? undefined : undefined)
      setNotifications(current => append ? [...current, ...next.items.filter(item => !current.some(existing => existing.id === item.id))] : next.items)
      setNotificationCursor(next.next_cursor)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tr('messages.loadNotificationsFailed'))
    } finally { setNotificationsBusy(false) }
  }

  const openNotification = useCallback(async (id: number) => {
    try {
      const item = notifications.find(row => row.id === id)
      const target = await desktopApi.notificationTarget(id)
      await desktopApi.notificationRead(id)
      setNotifications(current => current.map(row => row.id === id ? { ...row, read_at: new Date().toISOString() } : row))
      setUnreadCount(count => Math.max(0, count - (item?.read_at ? 0 : 1)))
      if (target.kind === 'price_alert_hit' && target.symbol) {
        const eventMarket = String(item?.template_params.market ?? '').toUpperCase()
        const found = allRows.find(row => row.stock.symbol === target.symbol && (!eventMarket || row.market === eventMarket))
        setPage('watch')
        if (found) { setSelection(found.accountId ? `account:${found.accountId}` : 'watch'); setSelectedKey(found.key) }
        else { setNotice(tr('messages.notificationStockUnavailable', { symbol: target.symbol })); setPage('messages') }
      } else if (target.kind === 'agent_run') {
        await desktopApi.openWeb('/history')
      } else {
        await desktopApi.openWeb('/assistant')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tr('messages.openNotificationFailed'))
    }
  }, [allRows, notifications, tr])

  const setPrivacyMode = (hidden: boolean) => {
    setPrivacy(hidden)
    desktopApi.setPrivacy(hidden)
    desktopApi.setMenuSummary({ title: activeMarket?.name ?? tr('market.closed'), subtitle: hidden ? tr('privacy.hiddenSummary') : `${tr('summary.floatingPnl')} ${currencyText(summaryPnl, locale)}` })
  }

  const updatePreferences = async (patch: Partial<DesktopConfig>) => {
    try {
      const result = await desktopApi.preferences(patch) as { ok?: boolean; error?: string; hotkeyStatus?: DesktopConfig['hotkeyStatus']; launchAtLogin?: boolean }
      if (!result.ok) throw new Error(result.error || tr('settings.saveFailed'))
      setConfig(current => current ? { ...current, ...patch, ...result } : current)
      if (patch.autoRefresh != null) setAutoRefresh(patch.autoRefresh)
      if (patch.refreshInterval != null) setRefreshInterval(patch.refreshInterval)
      if (patch.visibleColumns) setColumns(patch.visibleColumns as ColumnKey[])
      if (patch.miniAlwaysOnTop != null || patch.hideNotificationAmounts != null || patch.hotkeyEnabled != null || patch.launchAtLogin != null) {
        toast(tr('settings.saved'), 'success')
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : tr('settings.saveFailed'))
    }
  }

  const toggleNotifications = async (enabled: boolean) => {
    try {
      const result = await desktopApi.enableNotifications(enabled) as { enabled: boolean }
      setConfig(current => current ? { ...current, notificationsEnabled: result.enabled } : current)
      if (enabled && !result.enabled) setNotice(tr('settings.notificationPermissionDenied'))
    } catch (error) { setNotice(error instanceof Error ? error.message : tr('settings.notificationSaveFailed')) }
  }

  const connect = async (event: FormEvent) => {
    event.preventDefault()
    setLoginBusy(true); setLoginError('')
    try {
      await desktopApi.connect(server.trim(), username.trim(), password, rememberSession)
      setPassword(''); setConnected(true); setPage('watch')
      setConfig(current => current ? { ...current, server, rememberSession, sessionAvailable: rememberSession } : current)
    } catch (error) { setLoginError(error instanceof Error ? error.message : tr('login.failed')) }
    finally { setLoginBusy(false) }
  }

  const createGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (!groupsReady) { setNotice(tr('groups.serverUpgrade')); return }
    setGroupBusy(true)
    try {
      const group = await desktopApi.createGroup(groupName.trim())
      await reloadGroups(); setGroupName(''); setGroupCreateOpen(false); setGroupManageOpen(true); setSelection(`custom:${group.id}`)
      toast(tr('groups.created'), 'success')
    } catch (error) { setNotice(error instanceof Error ? error.message : tr('groups.createFailed')) }
    finally { setGroupBusy(false) }
  }

  const saveGroupMembers = async () => {
    if (!selectedRow) return
    setGroupBusy(true)
    try {
      const changes = watchGroups.filter(group => group.members.some(member => member.stock_id === selectedRow.stock.id) !== memberSelections.includes(group.id)).map(group => ({
        group_id: group.id,
        version: group.version,
        stock_ids: memberSelections.includes(group.id)
          ? [...group.members.map(member => member.stock_id), selectedRow.stock.id]
          : group.members.filter(member => member.stock_id !== selectedRow.stock.id).map(member => member.stock_id),
      }))
      if (changes.length) await desktopApi.setGroupsMembers(changes)
      await reloadGroups(); setMemberOpen(false); toast(tr('groups.membersSaved'), 'success')
    } catch (error) { setNotice(error instanceof Error ? error.message : tr('groups.syncFailed')) }
    finally { setGroupBusy(false) }
  }

  const renameGroup = async (event: FormEvent) => {
    event.preventDefault()
    if (!renameTarget) return
    setGroupBusy(true)
    try {
      await desktopApi.renameGroup(renameTarget, renameValue.trim())
      await reloadGroups(); setRenameTarget(null); setRenameValue(''); toast(tr('groups.renamed'), 'success')
    } catch (error) { setNotice(error instanceof Error ? error.message : tr('groups.syncFailed')) }
    finally { setGroupBusy(false) }
  }

  const deleteGroup = async (group: WatchGroup) => {
    if (!(await showConfirm(tr('groups.deleteConfirm', { name: group.name }), { destructive: true }))) return
    setGroupBusy(true)
    try {
      await desktopApi.deleteGroup(group)
      if (selection === `custom:${group.id}`) setSelection('watch')
      await reloadGroups(); toast(tr('groups.deleted'), 'success')
    } catch (error) { setNotice(error instanceof Error ? error.message : tr('groups.syncFailed')) }
    finally { setGroupBusy(false) }
  }

  const moveGroup = async (group: WatchGroup, direction: -1 | 1) => {
    const index = watchGroups.findIndex(item => item.id === group.id)
    const next = index + direction
    if (next < 0 || next >= watchGroups.length) return
    const reordered = [...watchGroups]
    ;[reordered[index], reordered[next]] = [reordered[next], reordered[index]]
    setGroupBusy(true)
    try {
      await desktopApi.setGroupOrder(reordered.map((item, sort_order) => ({ group_id: item.id, sort_order, version: item.version })))
      await reloadGroups()
    } catch (error) { setNotice(error instanceof Error ? error.message : tr('groups.syncFailed')) }
    finally { setGroupBusy(false) }
  }

  const moveWatchStock = async (stockId: number, direction: -1 | 1) => {
    const from = visibleWatchRows.findIndex(row => row.stock.id === stockId)
    const nextVisible = from + direction
    if (from < 0 || nextVisible < 0 || nextVisible >= visibleWatchRows.length) return
    const ordered = [...stocks].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id)
    const fromIndex = ordered.findIndex(stock => stock.id === stockId)
    const toIndex = ordered.findIndex(stock => stock.id === visibleWatchRows[nextVisible].stock.id)
    if (fromIndex < 0 || toIndex < 0) return
    ;[ordered[fromIndex], ordered[toIndex]] = [ordered[toIndex], ordered[fromIndex]]
    const next = ordered.map((stock, sort_order) => ({ ...stock, sort_order: sort_order + 1 }))
    setStocks(next)
    try { await desktopApi.reorderStocks(next.map(stock => ({ id: stock.id, sort_order: stock.sort_order ?? 0 }))) }
    catch (error) { setNotice(error instanceof Error ? error.message : tr('table.reorderFailed')); await refresh() }
  }

  const cycleAccount = () => {
    const accounts = portfolio?.accounts ?? []
    if (!accounts.length) { setSelection('all'); return }
    const current = selection.startsWith('account:') ? accounts.findIndex(account => String(account.id) === selection.slice('account:'.length)) : -1
    const next = current + 1
    setSelection(next >= accounts.length ? 'all' : `account:${accounts[next].id}`)
  }

  const beginMemberEdit = () => {
    if (!selectedRow || !groupsReady) return
    setMemberSelections(watchGroups.filter(group => group.members.some(member => member.stock_id === selectedRow.stock.id)).map(group => group.id))
    setMemberOpen(true)
  }

  const toggleSort = (target: SortKey) => {
    if (sortKey === target) setSortDirection(direction => direction === 'asc' ? 'desc' : 'asc')
    else { setSortKey(target); setSortDirection(target === 'name' ? 'asc' : 'desc') }
  }

  const currentAccountPositions = selection.startsWith('account:') ? accountRows.filter(row => String(row.accountId) === selection.slice('account:'.length)) : accountRows

  if (isMiniWindow) return <MiniWindow snapshot={miniSnapshot} privacy={privacy} tr={tr} onOpenMain={() => void desktopApi.nativeWindow('main')} onSelect={key => void desktopApi.selectStock(key)} onTogglePrivacy={() => { const hidden = !privacy; setPrivacy(hidden); desktopApi.setPrivacy(hidden) }} />

  if (!connected) return <main className="connect-screen"><section className="connect-card">
    <div className="wordmark"><span><TrendingUp size={19}/></span> PANWATCH / DESKTOP</div>
    <h1>{tr('login.title')}</h1><p>{tr('login.description')}</p>
    <form onSubmit={connect}>
      <label>{tr('login.server')}<input required type="url" value={server} onChange={event => setServer(event.target.value)} placeholder="http://127.0.0.1:8000" /></label>
      <label>{tr('login.username')}<input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label>{tr('login.password')}<input required autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>
      <label className="remember-row"><input type="checkbox" checked={rememberSession} onChange={event => setRememberSession(event.target.checked)} />{tr('login.remember')}<span><LockKeyhole size={13}/>{tr('login.keychainNote')}</span></label>
      {loginError && <div role="alert" className="inline-error">{loginError}</div>}
      <button className="primary wide" disabled={loginBusy}>{loginBusy ? tr('login.checking') : tr('login.connect')}</button>
    </form>
  </section></main>

  const selectPage = (target: Page) => { setPage(target); setNotice('') }
  return <main className="desktop-shell">
    <header className="topbar">
      <div className="titlemark"><span className="mark"><TrendingUp size={16}/></span><b>PanWatch</b><span className="desk-tag">{tr('brand.desktop')}</span></div>
      <nav className="topnav" aria-label={tr('nav.label')}>
        <button className={page === 'watch' ? 'nav-active' : ''} onClick={() => selectPage('watch')}><LayoutDashboard size={15}/>{tr('nav.watch')}</button>
        <button className={page === 'messages' ? 'nav-active' : ''} onClick={() => selectPage('messages')}><Bell size={15}/>{tr('nav.messages')}{unreadCount > 0 && <i>{unreadCount}</i>}</button>
        <button className={page === 'portfolio' ? 'nav-active' : ''} onClick={() => selectPage('portfolio')}><Activity size={15}/>{tr('nav.portfolio')}</button>
      </nav>
      <div className="top-actions">
        <button className="icon-button" title={privacy ? tr('privacy.show') : tr('privacy.hide')} aria-label={privacy ? tr('privacy.show') : tr('privacy.hide')} onClick={() => setPrivacyMode(!privacy)}>{privacy ? <EyeOff/> : <Eye/>}</button>
        <button className="quiet-button" onClick={() => void desktopApi.nativeWindow('mini')}><Menu size={14}/><span>{tr('nav.mini')}</span></button>
        <button className="icon-button" title={tr('settings.title')} aria-label={tr('settings.title')} onClick={() => setSettingsOpen(true)}><Settings2/></button>
      </div>
    </header>

    <section className="summarybar">
      <button className="account-select" title={tr('summary.switchAccount')} onClick={cycleAccount}><ChevronDown size={14}/>{summaryAccount?.name ?? tr('summary.allAccounts')}</button>
      <div className="metric"><label>{tr('summary.marketValue')}</label><strong>{privacy ? '••••••' : currencyText(summaryValue, locale)}</strong></div>
      <div className="metric"><label>{tr('summary.floatingPnl')}</label><strong className={tone(summaryPnl)}>{privacy ? '••••••' : currencyText(summaryPnl, locale)}</strong></div>
      <div className="metric"><label>{tr('summary.todayPnl')}</label><strong className={tone(summaryDaily)}>{privacy ? '••••••' : currencyText(summaryDaily, locale)}</strong></div>
      <div className="market-status"><span className={activeMarket ? 'status-dot live' : 'status-dot'}/>{activeMarket ? `${tr(`markets.${activeMarket.code}`)} ${activeMarket.status_text}` : tr('market.closed')}</div>
    </section>

    <div className="content-grid">
      <aside className="sidebar">
        <div className="side-heading">{tr('groups.positions')}</div>
        <GroupButton group={{ id: 'all', name: tr('groups.allPositions'), count: accountRows.length }} selected={selection === 'all'} onSelect={setSelection}/>
        {(portfolio?.accounts ?? []).map(account => <GroupButton key={account.id} group={{ id: `account:${account.id}`, name: account.name, count: account.positions.length }} selected={selection === `account:${account.id}`} onSelect={setSelection}/>) }
        <div className="side-rule"/>
        <div className="side-heading side-heading-space">{tr('groups.watch')}<span className="side-tools"><button className="add-group" aria-label={tr('groups.new')} title={tr('groups.new')} disabled={!groupsReady} onClick={() => setGroupCreateOpen(true)}><FolderPlus size={15}/></button><button className="add-group" aria-label={tr('groups.manage')} title={tr('groups.manage')} disabled={!groupsReady} onClick={() => setGroupManageOpen(true)}><MoreHorizontal size={15}/></button></span></div>
        <GroupButton group={{ id: 'watch', name: tr('groups.allWatch'), count: unheldStocks.length }} selected={selection === 'watch'} onSelect={setSelection}/>
        {[...new Set(unheldStocks.map(stock => stock.market))].map(market => <GroupButton key={market} group={{ id: `market:${market}`, name: tr(`markets.${market}`), count: unheldStocks.filter(stock => stock.market === market).length }} selected={selection === `market:${market}`} onSelect={setSelection}/>) }
        {watchGroups.map(group => <GroupButton key={group.id} group={{ id: `custom:${group.id}`, name: group.name, count: group.members.length }} selected={selection === `custom:${group.id}`} onSelect={setSelection}/>) }
        <div className="side-rule"/>
        <div className="side-heading">{tr('groups.smartFilters')}</div>
        <button className="group-button" onClick={() => { setSelection('all'); setQuery(''); setPage('watch') }}><ListFilter size={15}/><span>{tr('groups.allFilter')}</span><small>⌘K</small></button>
        <button className="group-button" onClick={() => setPage('messages')}><BellRing size={15}/><span>{tr('groups.todayMessages')}</span><small>{unreadCount || ''}</small></button>
        <div className="sidebar-bottom"><div><span className={notice ? 'status-dot' : 'status-dot live'}/>{notice ? tr('status.needsAttention') : tr('status.connected')}</div><small>{lastUpdated ? tr('status.updated', { time: lastUpdated }) : tr('status.waiting')}</small></div>
      </aside>

      {page === 'watch' ? <>
        <section className="watch-area">
          <div className="list-toolbar"><div><span className="eyebrow">WATCHLIST / 01</span><h1>{groupScreenTitle}<small>{tr('table.itemCount', { count: sourceRows.length })}</small></h1></div>
            <div className="toolbar-actions"><label className="search-field"><Search size={15}/><input aria-label={tr('table.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('table.searchPlaceholder')}/><kbd>⌘F</kbd></label><button className="outline-button" title={tr('table.refresh')} aria-label={tr('table.refresh')} onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''}/></button><button className="outline-button" onClick={() => setColumnOpen(true)}><Settings2 size={15}/>{tr('table.columns')}</button></div>
          </div>
          {notice && <div className="notice-banner" role="status"><span>{notice}</span><button aria-label={tr('actions.dismiss')} onClick={() => setNotice('')}><X size={15}/></button></div>}
          <div className="stock-table-wrap"><table className="stock-table"><thead><tr>
            <SortHeader label={tr('table.stock')} active={sortKey === 'name'} direction={sortDirection} onClick={() => toggleSort('name')}/>
            <SortHeader label={tr('table.price')} active={sortKey === 'price'} direction={sortDirection} onClick={() => toggleSort('price')}/>
            <SortHeader label={tr('table.change')} active={sortKey === 'change'} direction={sortDirection} onClick={() => toggleSort('change')}/>
            {columns.includes('daily') && <th>{tr('table.todayPnl')}</th>}
            {columns.includes('cost') && <th>{tr('table.cost')}</th>}
            {columns.includes('shares') && <th>{tr('table.shares')}</th>}
            <SortHeader label={tr('table.pnl')} active={sortKey === 'pnl'} direction={sortDirection} onClick={() => toggleSort('pnl')}/>
            {columns.includes('weight') && <SortHeader label={tr('table.weight')} active={sortKey === 'weight'} direction={sortDirection} onClick={() => toggleSort('weight')}/>}
            {selection === 'watch' && <th>{tr('table.manualOrder')}</th>}
          </tr></thead><tbody>{sourceRows.map(row => <tr key={row.key} onClick={() => setSelectedKey(row.key)} className={row.key === selectedRow?.key ? 'selected-row' : ''}>
            <td className="stock-name"><b>{row.stock.name}</b><small>{row.market}:{row.stock.symbol}{row.accountId ? ` · ${row.accountName}` : ''}</small></td>
            <td className="num">{privacy ? '••••' : currencyText(row.price, locale, currencyFor(row.market))}</td>
            <td className={`num ${tone(row.change)}`}>{signedPercent(row.change, locale)}</td>
            {columns.includes('daily') && <td className={`num ${tone(row.dailyPnl)}`}>{privacy ? '••••' : row.dailyPnl == null ? '—' : currencyText(row.dailyPnl, locale)}</td>}
            {columns.includes('cost') && <td className="num">{privacy ? '••••' : row.cost == null ? '—' : currencyText(row.cost, locale, currencyFor(row.market))}</td>}
            {columns.includes('shares') && <td className="num">{privacy ? '••••' : row.shares == null ? '—' : numberText(row.shares, locale, 0)}</td>}
            <td className={`num ${tone(row.pnl)}`}>{privacy ? '••••' : row.pnl == null ? '—' : currencyText(row.pnl, locale)}</td>
            {columns.includes('weight') && <td className="num">{privacy ? '••••' : row.weight == null ? '—' : signedPercent(row.weight, locale)}</td>}
            {selection === 'watch' && <td className="row-order"><button aria-label={tr('table.moveUp', { name: row.stock.name })} disabled={query.length > 0 || sortKey !== 'manual' || visibleWatchRows[0]?.stock.id === row.stock.id} onClick={event => { event.stopPropagation(); void moveWatchStock(row.stock.id, -1) }}>↑</button><button aria-label={tr('table.moveDown', { name: row.stock.name })} disabled={query.length > 0 || sortKey !== 'manual' || visibleWatchRows[visibleWatchRows.length - 1]?.stock.id === row.stock.id} onClick={event => { event.stopPropagation(); void moveWatchStock(row.stock.id, 1) }}>↓</button></td>}
          </tr>)}</tbody></table>
            {!sourceRows.length && <div className="empty-state"><div>◎</div><b>{query ? tr('table.noMatch') : tr('table.emptyTitle')}</b><span>{query ? tr('table.noMatchHint') : tr('table.emptyHint')}</span></div>}
          </div>
          <div className="table-foot"><span>{tr('table.pnlMethod')}</span><span>{tr('table.countFoot', { shown: sourceRows.length, total: isWatch ? stocks.length : currentAccountPositions.length })}</span></div>
        </section>
        <StockDetail row={selectedRow} quote={selectedQuote} market={selectedMarket} klines={detailKlines} insight={detailInsight} strategySignals={detailStrategySignals} strategyBusy={detailStrategyBusy} loading={detailBusy} privacy={privacy} watchGroups={watchGroups} groupsReady={groupsReady} positionDetails={positionDetails} locale={locale} tr={tr} onEditGroups={beginMemberEdit} onOpenWeb={route => void desktopApi.openWeb(route)} />
      </> : page === 'messages' ? <NotificationCenter items={notifications} unreadCount={unreadCount} pendingCount={pendingCount} busy={notificationsBusy} hasMore={!!notificationCursor} tr={tr} onRefresh={() => void loadNotifications(false)} onMore={() => void loadNotifications(true)} onOpen={id => void openNotification(id)}/> : <PortfolioOverview diagnostics={portfolioDiagnostics} attribution={portfolioAttribution} benchmark={portfolioBenchmark} aiReview={portfolioAiReview} busy={portfolioBusy} aiBusy={aiReviewBusy} privacy={privacy} locale={locale} tr={tr} onAIReview={async () => {
        setAiReviewBusy(true)
        try { setPortfolioAiReview(await desktopApi.portfolioAiReview()) }
        catch (error) { setNotice(error instanceof Error ? error.message : tr('portfolio.aiReviewFailed')) }
        finally { setAiReviewBusy(false) }
      }} onOpenWeb={() => void desktopApi.openWeb('/portfolio')}/>}
    </div>

    <footer className="app-footer"><span><span className="status-dot live"/>{tr('status.connected')}</span><span><Clock3 size={13}/>{autoRefresh ? tr('status.refreshing', { seconds: refreshInterval }) : tr('status.refreshPaused')} · {tr('status.marketDelay')}</span><button onClick={() => void updatePreferences({ autoRefresh: !autoRefresh })}>{autoRefresh ? tr('status.pause') : tr('status.resume')}</button></footer>

    {groupCreateOpen && <Modal title={tr('groups.createTitle')} eyebrow="WATCH GROUP" onClose={() => setGroupCreateOpen(false)}>
      <form className="settings-panel" onSubmit={createGroup}>
        <p>{tr('groups.description')}</p><label>{tr('groups.name')}<input autoFocus maxLength={40} required value={groupName} onChange={event => setGroupName(event.target.value)} placeholder={tr('groups.namePlaceholder')}/></label><button className="primary wide" disabled={groupBusy}>{groupBusy ? tr('actions.saving') : tr('groups.create')}</button>
      </form>
    </Modal>}
    {groupManageOpen && <Modal title={tr('groups.manageTitle')} eyebrow="WATCH GROUP" onClose={() => setGroupManageOpen(false)}>
      <p className="dialog-note">{tr('groups.description')}</p><div className="group-manage-list">
        {watchGroups.map((group, index) => <div className="group-manage-row" key={group.id}><div className="group-manage-label"><b>{group.name}</b><small>{tr('groups.memberCount', { count: group.members.length })}</small></div>
          <button className="icon-button" aria-label={tr('groups.moveUp', { name: group.name })} disabled={index === 0 || groupBusy} onClick={() => void moveGroup(group, -1)}><ArrowUp size={14}/></button><button className="icon-button" aria-label={tr('groups.moveDown', { name: group.name })} disabled={index === watchGroups.length - 1 || groupBusy} onClick={() => void moveGroup(group, 1)}><ArrowDown size={14}/></button>
          <button className="icon-button" aria-label={tr('groups.rename', { name: group.name })} onClick={() => { setRenameTarget(group); setRenameValue(group.name) }}><Settings2 size={14}/></button><button className="icon-button destructive-icon" aria-label={tr('groups.delete', { name: group.name })} onClick={() => void deleteGroup(group)} disabled={groupBusy}><X size={14}/></button>
        </div>)}
        {!watchGroups.length && <div className="empty-state compact-empty">{tr('groups.empty')}</div>}
      </div><button className="primary wide" onClick={() => { setGroupManageOpen(false); setGroupCreateOpen(true) }}><FolderPlus size={14}/>{tr('groups.new')}</button>
    </Modal>}
    {renameTarget && <Modal title={tr('groups.renameTitle')} eyebrow="WATCH GROUP" onClose={() => setRenameTarget(null)}><form className="settings-panel" onSubmit={renameGroup}><label>{tr('groups.name')}<input autoFocus maxLength={40} value={renameValue} onChange={event => setRenameValue(event.target.value)} /></label><button className="primary wide" disabled={groupBusy}>{groupBusy ? tr('actions.saving') : tr('actions.save')}</button></form></Modal>}
    {memberOpen && <Modal title={tr('groups.memberTitle')} eyebrow="WATCH GROUP" onClose={() => setMemberOpen(false)}><div className="member-dialog"><p>{tr('groups.memberDescription', { name: selectedRow?.stock.name ?? '' })}</p>{watchGroups.map(group => <label className="member-choice" key={group.id}><input type="checkbox" checked={memberSelections.includes(group.id)} onChange={event => setMemberSelections(current => event.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))}/><span>{group.name}</span><small>{group.members.length}</small></label>)}{!watchGroups.length && <div className="empty-state compact-empty">{tr('groups.empty')}</div>}<button className="primary wide" disabled={groupBusy || !watchGroups.length} onClick={() => void saveGroupMembers()}>{groupBusy ? tr('actions.saving') : tr('actions.save')}</button></div></Modal>}
    {columnOpen && <Modal title={tr('table.columnTitle')} eyebrow="TABLE" onClose={() => setColumnOpen(false)}><div className="column-settings">{(['daily', 'cost', 'shares', 'weight'] as ColumnKey[]).map(key => <label key={key}><input type="checkbox" checked={columns.includes(key)} onChange={event => {
        const next = event.target.checked ? [...columns, key] : columns.filter(column => column !== key)
        void updatePreferences({ visibleColumns: next })
      }}/><span>{tr(`table.columnsMap.${key}`)}</span></label>)}</div></Modal>}
    {settingsOpen && <Modal title={tr('settings.title')} eyebrow="MACOS" onClose={() => setSettingsOpen(false)}>
      <div className="settings-panel settings-dialog"><p>{tr('settings.description', { server })}</p>
        <label className="setting-toggle"><span>{tr('settings.autoRefresh')}</span><input type="checkbox" checked={autoRefresh} onChange={event => void updatePreferences({ autoRefresh: event.target.checked })}/></label>
        <label>{tr('settings.refreshInterval')}<div className="segmented-control">{[10, 30, 60, 120].map(seconds => <button key={seconds} className={refreshInterval === seconds ? 'segment-selected' : ''} onClick={() => void updatePreferences({ refreshInterval: seconds })}>{seconds}{tr('settings.seconds')}</button>)}</div></label>
        <label className="setting-toggle"><span>{tr('settings.systemNotifications')}</span><input type="checkbox" checked={config?.notificationsEnabled ?? false} onChange={event => void toggleNotifications(event.target.checked)}/></label>
        <label className="setting-toggle"><span>{tr('settings.hideNotificationAmounts')}</span><input type="checkbox" checked={config?.hideNotificationAmounts ?? true} onChange={event => void updatePreferences({ hideNotificationAmounts: event.target.checked })}/></label>
        <label className="setting-toggle"><span>{tr('settings.globalShortcut')}<small>{tr('settings.shortcutHint')}</small></span><input type="checkbox" checked={config?.hotkeyEnabled ?? true} onChange={event => void updatePreferences({ hotkeyEnabled: event.target.checked })}/></label>
        <div className="settings-meta"><LockKeyhole size={14}/>{tr(`settings.shortcutStatus.${config?.hotkeyStatus ?? 'disabled'}`)}</div>
        <label className="setting-toggle"><span>{tr('settings.miniAlwaysOnTop')}</span><input type="checkbox" checked={config?.miniAlwaysOnTop ?? true} onChange={event => void updatePreferences({ miniAlwaysOnTop: event.target.checked })}/></label>
        <label className="setting-toggle"><span>{tr('settings.launchAtLogin')}<small>{tr('settings.launchHint')}</small></span><input type="checkbox" checked={config?.launchAtLogin ?? false} onChange={event => void updatePreferences({ launchAtLogin: event.target.checked })}/></label>
        <div className="settings-meta"><LockKeyhole size={14}/>{tr('login.keychainNote')}</div>
        <button className="primary wide" onClick={() => { setSettingsOpen(false); void desktopApi.logout(); setConnected(false); setPortfolio(null); setStocks([]); setWatchGroups([]); setQuotes({}); setMarkets({}) }}>{tr('settings.switchAccount')}</button>
      </div>
    </Modal>}
  </main>
}

function SortHeader({ label, active, direction, onClick }: { label: string; active: boolean; direction: SortDirection; onClick: () => void }) {
  return <th><button className="sort-heading" onClick={onClick}>{label}{active && <span>{direction === 'asc' ? '↑' : '↓'}</span>}</button></th>
}

function GroupButton({ group, selected, onSelect }: { group: { id: string; name: string; count: number }; selected: boolean; onSelect: (id: string) => void }) {
  const glyph = group.id === 'all' ? '▤' : group.id.startsWith('account:') ? '▱' : group.id === 'watch' ? '☆' : group.id.startsWith('custom:') ? '◇' : '◌'
  return <button className={`group-button ${selected ? 'group-selected' : ''}`} onClick={() => onSelect(group.id)}><span className="group-glyph">{glyph}</span><span>{group.name}</span><small>{group.count}</small></button>
}

function StockDetail({ row, quote, market, klines, insight, strategySignals, strategyBusy, loading, privacy, watchGroups, groupsReady, positionDetails, locale, tr, onEditGroups, onOpenWeb }: {
  row: DisplayRow | undefined; quote: Quote | undefined; market: Market | undefined; klines: KlineResponse | null; insight: Insight | null; strategySignals: StrategySignalSummary[]; strategyBusy: boolean; loading: boolean; privacy: boolean; watchGroups: WatchGroup[]; groupsReady: boolean; positionDetails: PositionRow[]; locale: string; tr: (key: string, options?: Record<string, unknown>) => string; onEditGroups: () => void; onOpenWeb: (route: '/portfolio' | '/alerts' | '/assistant' | '/opportunities' | '/history') => void
}) {
  if (!row) return <aside className="detail-pane detail-empty"><LineChart size={22}/><span>{tr('detail.selectStock')}</span></aside>
  const points = klines?.klines?.map(item => item.close).filter(value => Number.isFinite(value)) ?? []
  const hasPoints = points.length > 2
  const minimum = hasPoints ? Math.min(...points) : 0
  const maximum = hasPoints ? Math.max(...points) : 1
  const range = maximum - minimum || 1
  const line = hasPoints ? points.map((value, index) => `${(index / (points.length - 1)) * 420},${178 - ((value - minimum) / range) * 154}`).join(' ') : ''
  const area = hasPoints ? `0,180 ${line} 420,180` : ''
  const conditionValid = validToday(quote, market)
  const groupNames = watchGroups.filter(group => group.members.some(member => member.stock_id === row.stock.id)).map(group => group.name)
  const suggestion = insight?.suggestion
  const suggestionLabel = suggestion && typeof suggestion === 'object'
    ? String(suggestion.summary ?? suggestion.suggestion ?? suggestion.action ?? '')
    : ''
  return <aside className="detail-pane">
    <div className="detail-head"><div><span className="eyebrow">STOCK / DETAIL</span><h2>{row.stock.name}</h2><p>{tr(`markets.${row.market}`)} · {row.stock.symbol} <span>· {tr(`currency.${currencyFor(row.market)}`)}</span></p></div></div>
    <div className="price-line"><b>{privacy ? '••••••' : numberText(row.price, locale)}</b><span className={`change-pill ${tone(conditionValid ? quote?.change_pct : null)}`}>{conditionValid ? signedPercent(quote?.change_pct, locale) : '—'}</span></div>
    <div className="quote-meta">{market?.status_text ?? tr('market.unknown')} · {quote?.quote_date ? tr('detail.quoteDate', { date: quote.quote_date }) : tr('detail.quoteMissing')}</div>
    <div className="chart-card"><div className="chart-title"><b>{tr('detail.last20Days')}</b><span>{loading ? tr('actions.loading') : points.length ? tr('detail.daily') : tr('detail.trendUnavailable')}</span></div>
      {hasPoints ? <svg viewBox="0 0 420 210" preserveAspectRatio="none" className="detail-chart"><defs><linearGradient id="chartfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2f795e" stopOpacity=".2"/><stop offset="1" stopColor="#2f795e" stopOpacity="0"/></linearGradient></defs><path d={`M ${area.replace(/ /g, ', ')} Z`} fill="url(#chartfill)"/><polyline points={line} fill="none" stroke="#32785e" strokeWidth="2.3" strokeLinejoin="round"/></svg> : <div className="chart-placeholder"><LineChart size={19}/><span>{loading ? tr('detail.loadingKlines') : tr('detail.noDailyData')}</span></div>}
    </div>
    <section className="detail-section"><div className="section-title"><b>{tr('detail.position')}</b><span className="micro-tag">{positionDetails.length} {tr('detail.accounts')}</span></div>
      {positionDetails.length ? positionDetails.map(position => <div className="holding-row" key={position.id}><span>{position.accountName} · {privacy ? '••••' : `${numberText(position.quantity, locale, 0)} ${tr('detail.shares')}`}</span><b className={tone(position.pnl)}>{privacy ? '••••' : currencyText(position.pnl, locale)}</b></div>) : <div className="holding-row"><span>{tr('detail.notHeld')}</span><span>—</span></div>}
      <div className="holding-row"><span>{tr('detail.costAndShares')}</span><b>{privacy ? '••••' : `${row.cost == null ? '—' : numberText(row.cost, locale)} / ${row.shares == null ? '—' : numberText(row.shares, locale, 0)}`}</b></div>
      <div className="holding-row"><span>{tr('detail.floatingPnl')}</span><b className={tone(row.pnl)}>{privacy ? '••••' : row.pnl == null ? '—' : currencyText(row.pnl, locale)}</b></div>
      <div className="holding-row"><span>{tr('detail.todayPnl')}</span><b className={tone(conditionValid ? row.dailyPnl : null)}>{privacy ? '••••' : conditionValid && row.dailyPnl != null ? currencyText(row.dailyPnl, locale) : '—'}</b></div>
    </section>
    <section className="detail-section"><div className="section-title"><b>{tr('detail.watchGroups')}</b><span className="micro-tag">{tr('detail.synced')}</span></div><p className="detail-note">{groupNames.join(' · ') || tr('detail.noWatchGroup')}</p><button className="add-alert" onClick={onEditGroups} disabled={!groupsReady}>{tr('groups.editMembership')}</button></section>
    <section className="detail-section alert-detail"><div className="section-title"><b>{tr('detail.priceAlerts')}</b><span className="micro-tag">{tr('detail.sharedRules')}</span></div><StockPriceAlertPanel symbol={row.stock.symbol} market={row.market} stockName={row.stock.name} stockId={row.stock.id} mode="inline" /></section>
    <section className="detail-section"><div className="section-title"><b>{tr('detail.latestResearch')}</b><span className="micro-tag">{loading ? tr('actions.loading') : insight?.suggestion ? tr('detail.hasSummary') : tr('detail.noSummary')}</span></div><p className="detail-note">{suggestionLabel || tr('detail.researchDescription')}</p><button className="report-link" onClick={() => onOpenWeb('/opportunities')}>{tr('detail.openResearch')} <ExternalLink size={13}/></button></section>
    <section className="detail-section"><div className="section-title"><b>{tr('detail.strategySignals')}</b><span className="micro-tag">{strategyBusy ? tr('actions.loading') : strategySignals[0]?.snapshot_date ?? tr('detail.noStrategySignals')}</span></div>
      {strategySignals.length ? <div className="strategy-signal-list">{strategySignals.map(item => <article className="strategy-signal-card" key={item.id}><div><b>{item.strategy_name}</b><span className="micro-tag">{item.risk_level_label}</span></div><p>{item.signal || item.reason}</p><small>{item.action_label} · {item.source_pool_label} · {tr(`detail.signalStatus.${item.status}`, { defaultValue: item.status })}</small></article>)}</div> : <p className="detail-note">{strategyBusy ? tr('actions.loading') : tr('detail.noStrategySignals')}</p>}
      <button className="report-link" onClick={() => onOpenWeb('/opportunities')}>{tr('detail.openStrategies')} <ExternalLink size={13}/></button>
    </section>
    {row.stock.agents && row.stock.agents.length > 0 && <section className="detail-section"><div className="section-title"><b>{tr('detail.boundAgents')}</b><span className="micro-tag">{row.stock.agents.length}</span></div><p className="detail-note">{row.stock.agents.map(agent => agent.agent_name).join(' · ')}</p><button className="report-link" onClick={() => onOpenWeb('/history')}>{tr('detail.openReports')} <ExternalLink size={13}/></button></section>}
    <div className="detail-actions"><button className="detail-primary" onClick={() => onOpenWeb('/assistant')}>{tr('detail.askAssistant')}</button><button className="detail-secondary" onClick={() => onOpenWeb('/portfolio')}>{tr('detail.webPortfolio')} <ExternalLink size={13}/></button></div>
  </aside>
}

function NotificationCenter({ items, unreadCount, pendingCount, busy, hasMore, tr, onRefresh, onMore, onOpen }: {
  items: NotificationItem[]; unreadCount: number; pendingCount: number; busy: boolean; hasMore: boolean; tr: (key: string, options?: Record<string, unknown>) => string; onRefresh: () => void; onMore: () => void; onOpen: (id: number) => void
}) {
  return <section className="full-panel notification-panel">
    <div className="list-toolbar"><div><span className="eyebrow">INBOX / 02</span><h1>{tr('messages.title')}<small>{tr('messages.unreadSummary', { unread: unreadCount, pending: pendingCount })}</small></h1></div><div className="toolbar-actions"><button className="outline-button" onClick={onRefresh} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{tr('messages.refresh')}</button></div></div>
    {busy && !items.length ? <div className="empty-state"><span>{tr('actions.loading')}</span></div> : <div className="notification-list">
      {items.map(item => <button type="button" className={`notification-card ${item.read_at ? '' : 'unread'}`} key={item.id} onClick={() => onOpen(item.id)}>
        <span className={`notification-mark ${item.severity}`}/><span className="notification-body"><span className="notification-title">{item.title}</span><span className="notification-copy">{tr(`messages.events.${item.event_type}`, { ...item.template_params, defaultValue: item.title })}</span><span className="notification-meta">{item.source} · {new Date(item.occurred_at).toLocaleString()}</span></span>
        {item.action_required && <span className="micro-tag">{tr('messages.actionRequired')}</span>}{!item.read_at && <span className="unread-dot"/>}
      </button>)}
      {!items.length && <div className="empty-state"><div>◎</div><b>{tr('messages.emptyTitle')}</b><span>{tr('messages.emptyHint')}</span></div>}
    </div>}
    {hasMore && <button className="load-more" onClick={onMore} disabled={busy}>{busy ? tr('actions.loading') : tr('messages.loadMore')}</button>}
    <p className="panel-footnote">{tr('messages.approvalHint')}</p>
  </section>
}

function PortfolioOverview({ diagnostics, attribution, benchmark, aiReview, busy, aiBusy, privacy, locale, tr, onAIReview, onOpenWeb }: {
  diagnostics: PortfolioDiagnostics | null; attribution: AttributionItem[]; benchmark: PortfolioBenchmark | null; aiReview: PortfolioAiReview | null; busy: boolean; aiBusy: boolean; privacy: boolean; locale: string; tr: (key: string, options?: Record<string, unknown>) => string; onAIReview: () => void; onOpenWeb: () => void
}) {
  const curve = benchmark?.curve ?? []
  const totalMarketValue = diagnostics?.total_market_value ?? 0
  const points = curve.map((item, index) => `${index / Math.max(1, curve.length - 1) * 100},${60 - ((item.portfolio - Math.min(...curve.map(point => point.portfolio))) / (Math.max(...curve.map(point => point.portfolio)) - Math.min(...curve.map(point => point.portfolio)) || 1)) * 50}`).join(' ')
  return <section className="full-panel portfolio-panel">
    <div className="list-toolbar"><div><span className="eyebrow">PORTFOLIO / 03</span><h1>{tr('portfolio.title')}<small>{tr('portfolio.subtitle')}</small></h1></div><button className="outline-button" onClick={onOpenWeb}>{tr('portfolio.webDetails')} <ExternalLink size={13}/></button></div>
    {busy && !diagnostics ? <div className="empty-state"><span>{tr('actions.loading')}</span></div> : <>
      <div className="analytics-cards">
        <article className="analytics-card"><span>{tr('portfolio.positionCount')}</span><b>{diagnostics?.position_count ?? '—'}</b></article>
        <article className="analytics-card"><span>{tr('portfolio.marketValue')}</span><b>{privacy ? '••••••' : diagnostics ? currencyText(diagnostics.total_market_value, locale) : '—'}</b></article>
        <article className="analytics-card"><span>{tr('portfolio.topWeight')}</span><b>{diagnostics ? signedPercent(diagnostics.max_weight * 100, locale) : '—'}</b></article>
        <article className="analytics-card"><span>{tr('portfolio.hhi')}</span><b>{diagnostics ? numberText(diagnostics.hhi, locale, 3) : '—'}</b></article>
      </div>
      <div className="analytics-grid">
        <section className="analytics-section"><div className="section-title"><b>{tr('portfolio.concentration')}</b><span className="micro-tag">{diagnostics?.position_count ?? 0} {tr('portfolio.positions')}</span></div>
          {diagnostics?.alerts?.length ? <ul className="risk-list">{diagnostics.alerts.map((alert, index) => <li key={index}>{alert}</li>)}</ul> : <p className="detail-note">{diagnostics ? tr('portfolio.noRiskFlags') : tr('portfolio.noDiagnostics')}</p>}
          <div className="market-breakdown">{Object.entries(diagnostics?.by_market ?? {}).map(([market, value]) => {
            const weight = totalMarketValue > 0 ? value / totalMarketValue * 100 : 0
            return <div key={market}><span>{tr(`markets.${market}`)}</span><div className="weight-track"><i style={{ width: `${Math.max(0, Math.min(100, weight))}%` }}/></div><b>{signedPercent(weight, locale)}</b></div>
          })}</div>
        </section>
        <section className="analytics-section"><div className="section-title"><b>{tr('portfolio.benchmark')}</b><span className="micro-tag">{benchmark?.benchmark_label ?? tr('portfolio.benchmarkName')}</span></div>
          {benchmark?.curve?.length ? <><svg viewBox="0 0 100 66" preserveAspectRatio="none" className="benchmark-chart"><polyline points={points} fill="none" stroke="#2f795e" strokeWidth="1.7" vectorEffect="non-scaling-stroke"/></svg><div className="benchmark-stats"><span>{tr('portfolio.portfolioReturn')} <b>{signedPercent(benchmark.portfolio_return, locale)}</b></span><span>{tr('portfolio.excessReturn')} <b className={tone(benchmark.excess_return)}>{signedPercent(benchmark.excess_return, locale)}</b></span></div></> : <div className="chart-placeholder">{tr(benchmark?.reason === 'insufficient_data' ? 'portfolio.benchmarkInsufficient' : 'portfolio.benchmarkUnavailable')}</div>}
        </section>
      </div>
      <section className="analytics-section attribution-section"><div className="section-title"><b>{tr('portfolio.contributors')}</b><span className="micro-tag">{attribution.length} {tr('portfolio.stocks')}</span></div>
        {attribution.length ? <div className="attribution-list">{[...attribution].sort((a, b) => b.contribution_pct - a.contribution_pct).slice(0, 8).map(item => <div key={`${item.market}:${item.symbol}`}><span>{item.name}<small>{item.market}:{item.symbol}</small></span><span>{signedPercent(item.weight_pct, locale)}</span><b className={tone(item.contribution_pct)}>{signedPercent(item.contribution_pct, locale)}</b></div>)}</div> : <p className="detail-note">{tr('portfolio.noAttribution')}</p>}
      </section>
      <section className="analytics-section ai-review-section"><div className="section-title"><b>{tr('portfolio.aiReview')}</b><button className="detail-secondary" onClick={onAIReview} disabled={aiBusy}>{aiBusy ? tr('actions.loading') : tr('portfolio.runAIReview')}</button></div>
        {aiReview?.content ? <p className="ai-review-copy">{aiReview.content}</p> : <p className="detail-note">{tr('portfolio.aiReviewDescription')}</p>}
        <p className="panel-footnote">{tr('portfolio.aiDisclaimer')}</p>
      </section>
    </>}
  </section>
}

function MiniWindow({ snapshot, privacy, tr, onOpenMain, onSelect, onTogglePrivacy }: {
  snapshot: MiniSnapshot | null; privacy: boolean; tr: (key: string, options?: Record<string, unknown>) => string; onOpenMain: () => void; onSelect: (key: string) => void; onTogglePrivacy: () => void
}) {
  const hidden = privacy || snapshot?.privacy
  return <main className="mini-shell"><header className="mini-header"><div><span className="mark"><TrendingUp size={14}/></span><b>PanWatch</b><small>{tr('nav.mini')}</small></div><span><button className="icon-button" aria-label={hidden ? tr('privacy.show') : tr('privacy.hide')} onClick={onTogglePrivacy}>{hidden ? <EyeOff size={14}/> : <Eye size={14}/>}</button><button className="icon-button" aria-label={tr('nav.openMain')} onClick={onOpenMain}><ExternalLink size={14}/></button></span></header>
    {!snapshot?.rows.length ? <div className="mini-empty">{tr('mini.waiting')}</div> : <div className="mini-stock-list">{snapshot.rows.map(row => <button key={row.key} onClick={() => onSelect(row.key)}><span><b>{row.name}</b><small>{row.market}:{row.symbol}</small></span><span className="mini-values"><b>{hidden ? '••••' : numberText(row.price, document.documentElement.lang || navigator.language)}</b><small className={tone(row.change)}>{signedPercent(row.change, document.documentElement.lang || navigator.language)}</small></span></button>)}</div>}
    <footer className="mini-footer"><span>{snapshot?.updated ? tr('status.updated', { time: snapshot.updated }) : tr('mini.waiting')}</span><span>{tr('mini.source', { time: snapshot?.updated ?? '—' })}</span></footer>
  </main>
}

function Modal({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent className="desktop-modal-content"><DialogHeader><span className="eyebrow">{eyebrow}</span><DialogTitle>{title}</DialogTitle></DialogHeader>{children}</DialogContent></Dialog>
}
