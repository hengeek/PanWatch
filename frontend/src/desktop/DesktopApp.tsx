import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Bell, BellRing, ChevronDown, HelpCircle, Clock3, Eye, EyeOff, ExternalLink, FolderPlus, LayoutDashboard, LineChart, ListFilter, LockKeyhole, RefreshCw, Search, Settings2, Star, TrendingUp, X } from 'lucide-react'
import { getCurrentLocale } from '../i18n'
import { desktopApi, type KlineResponse, type Market, type Portfolio, type Quote, type Stock } from './api'
import type { WatchGroup } from '@panwatch/api/watch-groups'

type Group = { id: string; name: string; count: number }
type PositionRow = NonNullable<Portfolio['accounts'][number]['positions'][number]> & { accountId: number; accountName: string }
type MarketMap = Record<string, Market>
const MARKET_KEYS = { CN: 'markets.CN', HK: 'markets.HK', US: 'markets.US' } as const
const fmt = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString(getCurrentLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })
const money = (n: number | null | undefined) => n == null ? '—' : `¥${fmt(n)}`
const percent = (n: number | null | undefined) => n == null ? '—' : `${n > 0 ? '+' : ''}${fmt(n)}%`
const cls = (n: number | null | undefined) => n == null || n === 0 ? 'flat' : n > 0 ? 'gain' : 'loss'
const validToday = (row: Quote | undefined, market: Market | undefined) => !!row && row.daily_move_status === 'current' && !!market && market.status === 'trading' && (!row.quote_date || row.quote_date === market.local_date)

export default function DesktopApp() {
  const { t } = useTranslation('desktop')
  const marketLabel = useCallback((market: string) => {
    const key = MARKET_KEYS[market as keyof typeof MARKET_KEYS]
    return key ? t(key) : market
  }, [t])
  const [server, setServer] = useState('http://127.0.0.1:8000')
  const [connected, setConnected] = useState(false)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [stocks, setStocks] = useState<Stock[]>([])
  const [watchGroups, setWatchGroups] = useState<WatchGroup[]>([])
  const [groupsReady, setGroupsReady] = useState(false)
  const [groupDialog, setGroupDialog] = useState(false)
  const [groupName, setGroupName] = useState('')
  const [groupBusy, setGroupBusy] = useState(false)
  const [memberDialog, setMemberDialog] = useState(false)
  const [memberSelections, setMemberSelections] = useState<number[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [markets, setMarkets] = useState<MarketMap>({})
    const [selection, setSelection] = useState('all')
  const [selectedKey, setSelectedKey] = useState('')
  const [query, setQuery] = useState('')
  const [unread, setUnread] = useState(0)
  const [updated, setUpdated] = useState('')
  const [privacy, setPrivacy] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [detail, setDetail] = useState<KlineResponse | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const rows: PositionRow[] = useMemo(() => (portfolio?.accounts ?? []).flatMap(account => (account.positions ?? []).map(position => ({ ...position, accountId: account.id, accountName: account.name }))), [portfolio])
  const groupsForScreen = useMemo(() => {
    const next: Group[] = [
      { id: 'all', name: t('sidebar.allPositions'), count: rows.length },
      ...(portfolio?.accounts ?? []).map(account => ({ id: `account:${account.id}`, name: account.name, count: account.positions.length })),
      { id: 'watch', name: t('sidebar.allWatch'), count: stocks.length },
      ...[...new Set(stocks.map(stock => stock.market))].map(market => ({ id: `market:${market}`, name: t('sidebar.marketGroupWatch', { market: marketLabel(market) }), count: stocks.filter(s => s.market === market).length })),
      ...watchGroups.map(group => ({ id: `custom:${group.id}`, name: group.name, count: group.members.length })),
    ]
    return next
  }, [portfolio, rows.length, stocks, watchGroups, t, marketLabel])

  const refresh = useCallback(async () => {
    if (!connected || busy) return
    setBusy(true)
    try {
      const [nextPortfolio, nextStocks, nextMarkets, nextUnread, nextGroups] = await Promise.all([
        desktopApi.portfolio(), desktopApi.stocks(), desktopApi.markets(), desktopApi.notificationSummary().catch(() => ({ unread_count: 0, pending_action_count: 0 })),
        desktopApi.groups().then(items => ({ items, ok: true })).catch(() => ({ items: [] as WatchGroup[], ok: false })),
      ])
      const items = [...new Map([...nextStocks, ...nextPortfolio.accounts.flatMap(account => account.positions)].map(stock => [`${stock.market}:${stock.symbol}`, { symbol: stock.symbol, market: stock.market }])).values()]
      const nextQuotes = items.length ? await desktopApi.quotes(items) : []
      const quoteMap = Object.fromEntries(nextQuotes.map(quote => [`${quote.market}:${quote.symbol}`, quote]))
      setPortfolio(nextPortfolio); setStocks(nextStocks); setMarkets(Object.fromEntries(nextMarkets.map(market => [market.code, market]))); setQuotes(quoteMap); setUnread(nextUnread.unread_count); setWatchGroups(nextGroups.items); setGroupsReady(nextGroups.ok)
      setNotice(''); setUpdated(new Date().toLocaleTimeString(undefined, { hour12: false }))
    } catch (error) {
      setNotice(t('notices.refreshFailed', { message: error instanceof Error ? error.message : t('notices.serviceUnavailable') }))
    } finally { setBusy(false) }
  }, [connected, busy, t])

  useEffect(() => { desktopApi.config().then(config => { if (config.server) setServer(config.server); setPrivacy(!!(config as { privacy?: boolean }).privacy) }).catch(() => undefined) }, [])
  useEffect(() => { if (connected) void refresh() }, [connected])
  useEffect(() => { if (!connected || !autoRefresh) return; const timer = window.setInterval(() => void refresh(), 30_000); return () => window.clearInterval(timer) }, [connected, autoRefresh, refresh])

  const loadGroups = async () => {
    try { setWatchGroups(await desktopApi.groups()); setGroupsReady(true); return true }
    catch { setGroupsReady(false); return false }
  }

  const createGroup = async (event: React.FormEvent) => {
    event.preventDefault(); setGroupBusy(true); setNotice('')
    try { const group = await desktopApi.createGroup(groupName); await loadGroups(); setGroupName(''); setGroupDialog(false); setSelection(`custom:${group.id}`) }
    catch (error) { setNotice(error instanceof Error ? error.message : t('notices.createGroupFailed')) }
    finally { setGroupBusy(false) }
  }

  const saveGroupMembers = async () => {
    const target = selectedRow?.stock.id; if (!target) return
    setGroupBusy(true)
    try {
      const changes = watchGroups.filter(group => group.members.some(member => member.stock_id === target) !== memberSelections.includes(group.id)).map(group => ({
        group_id: group.id,
        version: group.version,
        stock_ids: memberSelections.includes(group.id)
          ? [...group.members.map(member => member.stock_id), target]
          : group.members.filter(member => member.stock_id !== target).map(member => member.stock_id),
      }))
      if (changes.length) await desktopApi.setGroupsMembers(changes)
      await loadGroups(); setMemberDialog(false); setNotice(t('notices.groupsUpdated'))
    } catch (error) { setNotice(error instanceof Error ? error.message : t('notices.groupsSyncFailed')) }
    finally { setGroupBusy(false) }
  }

  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setLoginError('')
    try {
      await desktopApi.connect(server.trim(), username.trim(), password)
      setPassword(''); setConnected(true)
    } catch (error) { setLoginError(error instanceof Error ? error.message : t('connect.error')) }
    finally { setBusy(false) }
  }

  useEffect(() => {
    if (!connected || !selectedKey) { setDetail(null); return }
    const [market, symbol] = selectedKey.split(':')
    let current = true; setDetailBusy(true)
    desktopApi.klines(symbol, market).then(data => { if (current) setDetail(data) }).catch(() => { if (current) setDetail(null) }).finally(() => { if (current) setDetailBusy(false) })
    return () => { current = false }
  }, [connected, selectedKey])

  const positions = selection.startsWith('account:') ? rows.filter(row => String(row.accountId) === selection.slice(8)) : rows
  const customGroup = selection.startsWith('custom:') ? watchGroups.find(group => String(group.id) === selection.slice(7)) : undefined
  const isWatch = selection === 'watch' || selection.startsWith('market:') || selection.startsWith('custom:')
  const selectedMarket = selection.startsWith('market:') ? selection.slice(7) : ''
  const groupStockIds = new Set(customGroup?.members.map(member => member.stock_id) ?? [])
  const currentItems = (isWatch ? stocks.filter(stock => selection === 'watch' || (selectedMarket && stock.market === selectedMarket) || (customGroup && groupStockIds.has(stock.id))).map(stock => {
    const quote = quotes[`${stock.market}:${stock.symbol}`]
    return { key: `${stock.market}:${stock.symbol}`, stock, price: quote?.current_price ?? null, change: validToday(quote, markets[stock.market]) ? quote?.change_pct ?? null : null, pnl: null, pnlPct: null, cnyValue: null, shares: null as number | null, cost: null as number | null, accountName: t('detail.watchAccount'), market: stock.market }
  }) : positions.map(position => {
    const quote = quotes[`${position.market}:${position.symbol}`]
    const current = quote?.current_price ?? position.current_price
    return { key: `${position.market}:${position.symbol}:${position.accountId}`, stock: { ...position, id: position.stock_id }, price: current, change: validToday(quote, markets[position.market]) ? quote?.change_pct ?? null : null, pnl: position.pnl, pnlPct: position.pnl_pct, cnyValue: position.market_value_cny, shares: position.quantity, cost: position.cost_price, accountName: position.accountName, market: position.market }
  })).filter(row => `${row.stock.name} ${row.stock.symbol}`.toLowerCase().includes(query.trim().toLowerCase()), [positions, isWatch, stocks, selectedMarket, quotes, markets, query])

  const selectedRow = currentItems.find(row => row.key === selectedKey) ?? currentItems[0]
  useEffect(() => { if (!currentItems.some(row => row.key === selectedKey)) setSelectedKey(currentItems[0]?.key ?? '') }, [currentItems, selectedKey])
  const selQuote = selectedRow ? quotes[`${selectedRow.market}:${selectedRow.stock.symbol}`] : undefined
  const totalValue = isWatch ? null : selection.startsWith('account:') ? portfolio?.accounts.find(a => String(a.id) === selection.slice(8))?.total_market_value : portfolio?.total.total_market_value
  const totalPnl = isWatch ? null : selection.startsWith('account:') ? portfolio?.accounts.find(a => String(a.id) === selection.slice(8))?.total_pnl : portfolio?.total.total_pnl
  const totalDaily = isWatch ? null : selection.startsWith('account:') ? portfolio?.accounts.find(a => String(a.id) === selection.slice(8))?.total_daily_pnl : portfolio?.total.total_daily_pnl
  const activeMarket = Object.values(markets).find(market => market.status === 'trading')

  if (!connected) return <main className="connect-screen"><section className="connect-card"><div className="wordmark"><span><TrendingUp size={19}/></span> {t('brand')}</div><h1>{t('connect.title')}</h1><p>{t('connect.description')}</p><form onSubmit={connect}>
    <label>{t('connect.server')}<input required type="url" value={server} onChange={event => setServer(event.target.value)} placeholder="http://127.0.0.1:8000" /></label>
    <label>{t('connect.username')}<input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
    <label>{t('connect.password')}<input required autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    {loginError && <div role="alert" className="inline-error">{loginError}</div>}
    <button className="primary wide" disabled={busy}>{busy ? t('connect.checking') : t('connect.submit')}</button>
  </form></section></main>

  return <main className="desktop-shell">
    <header className="topbar"><div className="titlemark"><span className="mark"><TrendingUp size={16}/></span><b>PanWatch</b><span className="desk-tag">{t('nav.deskTag')}</span></div>
      <nav className="topnav"><button className="nav-active"><LayoutDashboard size={15}/>{t('nav.watch')}</button><button onClick={() => setNotice(t('notices.messages'))}><Bell size={15}/>{t('nav.messages')}{unread > 0 && <i>{unread}</i>}</button><button onClick={() => setNotice(t('notices.portfolio'))}><Activity size={15}/>{t('nav.portfolio')}</button></nav>
      <div className="top-actions"><button className="icon-button" title={privacy ? t('nav.showAmounts') : t('nav.hideAmounts')} onClick={() => { setPrivacy(!privacy); desktopApi.setPrivacy(!privacy) }}>{privacy ? <EyeOff/> : <Eye/>}</button><button className="quiet-button" onClick={() => setNotice(t('notices.miniWindow'))}>□ <span>{t('nav.miniWindow')}</span></button><button className="icon-button" title={t('nav.settings')} onClick={() => setShowSettings(true)}><Settings2/></button></div>
    </header>
    <section className="summarybar"><button className="account-select" onClick={() => setSelection('all')}><ChevronDown size={14}/>{selection.startsWith('account:') ? portfolio?.accounts.find(a=>String(a.id)===selection.slice(8))?.name ?? t('summary.allAccounts') : t('summary.allAccounts')}</button><div className="metric"><label>{t('summary.marketValue')}</label><strong>{privacy ? t('table.privacyWide') : money(totalValue)}</strong></div><div className="metric"><label>{t('summary.totalPnl')}</label><strong className={cls(totalPnl)}>{privacy ? t('table.privacyWide') : money(totalPnl)}</strong></div><div className="metric"><label>{t('summary.dailyPnl')}</label><strong className={cls(totalDaily)}>{privacy ? t('table.privacyWide') : money(totalDaily)}</strong></div><div className="market-status"><span className={activeMarket ? 'status-dot live' : 'status-dot'}/>{activeMarket ? t('summary.marketOpen', { name: activeMarket.name, status: activeMarket.status_text, time: activeMarket.local_time ?? '' }) : t('summary.marketClosed')}</div></section>
    <div className="content-grid"><aside className="sidebar"><div className="side-heading">{t('sidebar.positions')}</div><GroupButton group={{id:'all',name:t('sidebar.allPositions'),count:rows.length}} selected={selection==='all'} onSelect={setSelection}/>{(portfolio?.accounts??[]).map(account=><GroupButton key={account.id} group={{id:`account:${account.id}`,name:account.name,count:account.positions.length}} selected={selection===`account:${account.id}`} onSelect={setSelection}/>) }
      <div className="side-rule"/><div className="side-heading side-heading-space">{t('sidebar.watchlist')} <button className="add-group" onClick={()=>groupsReady?setGroupDialog(true):setNotice(t('notices.groupsUnavailable'))} aria-label={t('sidebar.addGroup')}><FolderPlus size={15}/></button></div>
      <GroupButton group={{id:'watch',name:t('sidebar.allWatch'),count:stocks.length}} selected={selection==='watch'} onSelect={setSelection}/>{[...new Set(stocks.map(s=>s.market))].map(market=><GroupButton key={market} group={{id:`market:${market}`,name:t('sidebar.marketWatch',{market:marketLabel(market)}),count:stocks.filter(s=>s.market===market).length}} selected={selection===`market:${market}`} onSelect={setSelection}/>)}{watchGroups.map(group=><GroupButton key={group.id} group={{id:`custom:${group.id}`,name:group.name,count:group.members.length}} selected={selection===`custom:${group.id}`} onSelect={setSelection}/>) }
      <div className="side-rule"/><div className="side-heading">{t('sidebar.smartFilter')}</div><button className="group-button" onClick={()=>{setSelection('all');setQuery('')}}><ListFilter size={15}/><span>{t('sidebar.allFilters')}</span><small>⌘K</small></button><button className="group-button" onClick={()=>desktopApi.openWeb('/alerts')}><BellRing size={15}/><span>{t('sidebar.todayAlerts')}</span><small>{unread || ''}</small></button>
      <div className="sidebar-bottom"><div><span className={notice?'status-dot':'status-dot live'}/>{notice?t('sidebar.statusPending'):t('sidebar.connected')}</div><small>{updated ? t('sidebar.updated', { time: updated }) : t('sidebar.waiting')}</small></div>
    </aside>
    <section className="watch-area"><div className="list-toolbar"><div><span className="eyebrow">{t('list.eyebrow')}</span><h1>{groupsForScreen.find(group=>group.id===selection)?.name ?? t('toolbar.allPositions')}<small>{t('toolbar.itemCount', { value: currentItems.length })}</small></h1></div><div className="toolbar-actions"><label className="search-field"><Search size={15}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('toolbar.search')}/><kbd>⌘F</kbd></label><button className="outline-button" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={14} className={busy?'spin':''}/></button><button className="outline-button" onClick={()=>setNotice(t('notices.columns'))}><Settings2 size={15}/>{t('toolbar.columns')}</button></div></div>
      {notice && <div className="notice-banner" role="status"><HelpCircle size={15}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label={t('notices.close')}><X size={15}/></button></div>}
      <div className="stock-table-wrap"><table className="stock-table"><thead><tr><th>{t('table.stock')}</th><th>{t('table.price')}</th><th>{t('table.change')}</th><th>{t('table.recent20')}</th><th>{t('table.pnl')}</th><th>{t('table.weight')}</th></tr></thead><tbody>{currentItems.map(row=>{const picked = row.key===selectedRow?.key;return <tr key={row.key} onClick={()=>setSelectedKey(row.key)} className={picked?'selected-row':''}><td className="stock-name"><b>{row.stock.name}</b><small>{row.market} {row.stock.symbol}{!isWatch?` · ${row.accountName}`:''}</small></td><td className="num">{privacy?t('table.privacy'):fmt(row.price)}</td><td className={`num ${cls(row.change)}`}>{percent(row.change)}</td><td><Sparkline values={selectedRow?.key===row.key ? (detail?.klines?.map(item=>item.close)??[]) : []} change={row.change}/></td><td className={`num ${cls(row.pnl)}`}>{privacy?t('table.privacy'):money(row.pnl)}</td><td className="num">{isWatch?'—':row.cnyValue!=null&&portfolio?.total.total_market_value ? `${fmt(row.cnyValue/portfolio.total.total_market_value*100)}%`:'—'}</td></tr>})}</tbody></table>
        {!currentItems.length && <div className="empty-state"><div>◎</div><b>{query?t('table.emptyMatch'):t('table.emptyGroup')}</b><span>{query?t('table.emptyMatchHint'):t('table.emptyGroupHint')}</span></div>}
      </div><div className="table-foot"><span>{t('table.footer')}</span><span>{currentItems.length} / {isWatch?stocks.length:positions.length}</span></div>
    </section>
    <StockDetail row={selectedRow} quote={selQuote} market={selectedRow?markets[selectedRow.market]:undefined} klines={detail} loading={detailBusy} isWatch={isWatch} privacy={privacy} watchGroups={watchGroups} groupsReady={groupsReady} onEditGroups={() => { setMemberSelections(watchGroups.filter(group=>group.members.some(member=>member.stock_id===selectedRow?.stock.id)).map(group=>group.id)); setMemberDialog(true) }} />
    </div>
    <footer className="app-footer"><span><span className="status-dot live"/> {t('footer.connected')}</span><span><Clock3 size={13}/>{autoRefresh?t('footer.refresh30'):t('footer.autoPaused')}{t('footer.delayed')}</span><button onClick={()=>setAutoRefresh(!autoRefresh)}>{autoRefresh?t('footer.pause'):t('footer.resume')}</button></footer>
    {groupDialog && <div className="modal-backdrop" onClick={()=>setGroupDialog(false)}><form className="settings-panel" onSubmit={createGroup} onClick={event=>event.stopPropagation()}><header><div><span className="eyebrow">{t('groups.eyebrow')}</span><h2>{t('groups.createTitle')}</h2></div><button type="button" className="icon-button" onClick={()=>setGroupDialog(false)}><X/></button></header><p>{t('groups.createDescription')}</p><label>{t('groups.name')}<input autoFocus maxLength={40} required value={groupName} onChange={event=>setGroupName(event.target.value)} placeholder={t('groups.namePlaceholder')}/></label><button className="primary wide" disabled={groupBusy}>{groupBusy?t('groups.saving'):t('groups.create')}</button></form></div>}
    {memberDialog && <div className="modal-backdrop" onClick={()=>setMemberDialog(false)}><section className="settings-panel group-members-panel" onClick={event=>event.stopPropagation()}><header><div><span className="eyebrow">{t('groups.eyebrow')}</span><h2>{t('groups.selectTitle')}</h2></div><button className="icon-button" onClick={()=>setMemberDialog(false)}><X/></button></header><p>{t('groups.selectDescription', { name: selectedRow?.stock.name ?? '' })}</p>{watchGroups.map(group=><label className="member-choice" key={group.id}><input type="checkbox" checked={memberSelections.includes(group.id)} onChange={event=>setMemberSelections(current=>event.target.checked?[...current,group.id]:current.filter(id=>id!==group.id))}/><span>{group.name}</span><small>{t('groups.count', { value: group.members.length })}</small></label>)}{watchGroups.length===0&&<div className="empty-state">{t('groups.empty')}</div>}<button className="primary wide" disabled={groupBusy||watchGroups.length===0} onClick={()=>void saveGroupMembers()}>{groupBusy?t('groups.syncing'):t('groups.save')}</button></section></div>}
    {showSettings && <div className="modal-backdrop" onClick={()=>setShowSettings(false)}><section className="settings-panel" onClick={event=>event.stopPropagation()}><header><div><span className="eyebrow">{t('settings.eyebrow')}</span><h2>{t('settings.title')}</h2></div><button className="icon-button" onClick={()=>setShowSettings(false)}><X/></button></header><p>{t('settings.description')}</p><label>{t('settings.server')}<input value={server} onChange={event=>setServer(event.target.value)}/></label><div className="settings-meta"><LockKeyhole size={15}/>{t('settings.passwordNote')}</div><button className="primary wide" onClick={()=>{setShowSettings(false);window.panWatchDesktop?.request('logout');setConnected(false);setPortfolio(null);setStocks([]);setWatchGroups([]);setQuotes({});setMarkets({});}}>{t('settings.logout')}</button></section></div>}
  </main>
}

function GroupButton({group,selected,onSelect}:{group:Group;selected:boolean;onSelect:(id:string)=>void}) {
  return <button className={`group-button ${selected?'group-selected':''}`} onClick={()=>onSelect(group.id)}><span className="group-glyph">{group.id==='all'?'▤':group.id.startsWith('account:')?'▱':group.id==='watch'?'☆':'◇'}</span><span>{group.name}</span><small>{group.count}</small></button>
}

function Sparkline({values,change}:{values:number[];change:number|null}) {
  const { t } = useTranslation('desktop')
  if(values.length<2) return <span className="spark-empty" aria-label={t('detail.unavailable')}>—</span>
  const min=Math.min(...values), max=Math.max(...values), range=max-min||1
  const points=values.map((value,index)=>`${(index/(values.length-1))*100},${36-((value-min)/range)*30}`).join(' ')
  return <svg className={`spark ${cls(change)}`} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={points}/></svg>
}

function StockDetail({row,quote,market,klines,loading,isWatch,privacy,watchGroups,groupsReady,onEditGroups}:{row:any;quote:Quote|undefined;market:Market|undefined;klines:KlineResponse|null;loading:boolean;isWatch:boolean;privacy:boolean;watchGroups:WatchGroup[];groupsReady:boolean;onEditGroups:()=>void}) {
  const { t } = useTranslation('desktop')
  const marketLabel = (marketCode: string) => {
    const key = MARKET_KEYS[marketCode as keyof typeof MARKET_KEYS]
    return key ? t(key) : marketCode
  }
  if(!row)return <aside className="detail-pane detail-empty"><LineChart size={22}/><span>{t('detail.empty')}</span></aside>
  const points=klines?.klines?.map(k=>k.close).filter(value=>Number.isFinite(value))??[]
  const hasPoints=points.length>2
  const min=hasPoints?Math.min(...points):0,max=hasPoints?Math.max(...points):1,range=max-min||1
  const line=hasPoints?points.map((value,index)=>`${(index/(points.length-1))*420},${178-((value-min)/range)*154}`).join(' '):''
  const area=hasPoints?`0,180 ${line} 420,180`:''
  const conditionValid=validToday(quote,market)
  return <aside className="detail-pane"><div className="detail-head"><div><span className="eyebrow">{t('detail.eyebrow')}</span><h2>{row.stock.name}</h2><p>{marketLabel(row.market)} {row.stock.symbol} <span>· {t(row.market==='HK'?'currencies.HKD':row.market==='US'?'currencies.USD':'currencies.CNY')}</span></p></div><button className="icon-button" title={t('detail.pin')}><Star size={17}/></button></div>
    <div className="price-line"><b>{privacy?t('table.privacyWide'):fmt(row.price)}</b><span className={`change-pill ${cls(conditionValid?quote?.change_pct:null)}`}>{conditionValid?percent(quote?.change_pct):'—'}</span></div><div className="quote-meta">{market?.status_text??t('detail.unknownStatus')} · {t('detail.quoteDate')} {quote?.quote_date??t('detail.noQuoteDate')}</div>
    <div className="chart-card"><div className="chart-title"><b>{t('detail.recent20')}</b><span>{loading?t('detail.loading'):points.length?t('detail.daily'):t('detail.unavailable')}</span></div>{hasPoints?<svg viewBox="0 0 420 210" preserveAspectRatio="none" className="detail-chart"><defs><linearGradient id="chartfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2f795e" stopOpacity=".2"/><stop offset="1" stopColor="#2f795e" stopOpacity="0"/></linearGradient></defs><path d={`M ${area.replace(/ /g, ', ')} Z`} fill="url(#chartfill)"/><polyline points={line} fill="none" stroke="#32785e" strokeWidth="2.3" strokeLinejoin="round"/></svg>:<div className="chart-placeholder"><LineChart size={19}/><span>{loading?t('detail.loadingKlines'):t('detail.noSource')}</span></div>}</div>
    <section className="detail-section"><div className="section-title"><b>{t('detail.position')}</b><button className="text-button">{isWatch?t('detail.watched'):t('detail.accountDetail')}</button></div>{isWatch?<div className="holding-row"><span>{t('detail.noPosition')}</span><span>—</span></div>:<><div className="holding-row"><span>{t('detail.account')}</span><b>{row.accountName}</b></div><div className="holding-row"><span>{t('detail.costShares')}</span><b>{privacy?t('table.privacy'):`${fmt(row.cost)} / ${row.shares!=null?t('detail.shares',{value:row.shares.toLocaleString(getCurrentLocale())}):'—'}`}</b></div><div className="holding-row"><span>{t('detail.pnl')}</span><b className={cls(row.pnl)}>{privacy?t('table.privacy'):money(row.pnl)}</b></div><div className="holding-row"><span>{t('detail.dailyPnl')}</span><b className={cls(conditionValid?row.daily_pnl:null)}>{privacy?t('table.privacy'):conditionValid?money(row.daily_pnl):'—'}</b></div></>}</section>
    <section className="detail-section"><div className="section-title"><b>{t('detail.groups')}</b><span className="micro-tag">{t('detail.syncedWithWeb')}</span></div><p className="detail-note">{watchGroups.filter(group=>group.members.some(member=>member.stock_id===row.stock.id)).map(group=>group.name).join(' · ') || t('detail.noCustomGroup')}</p><button className="add-alert" onClick={onEditGroups} disabled={!groupsReady}>{t('detail.editGroups')}</button></section>
    <section className="detail-section report-section"><div className="section-title"><b>{t('detail.latestAnalysis')}</b><span className="micro-tag">{t('detail.reportEntry')}</span></div><p className="detail-note">{t('detail.reportDescription')}</p><button className="report-link" onClick={()=>desktopApi.openWeb('/portfolio')}>{t('detail.openWeb')} <ExternalLink size={13}/></button></section>
    <div className="detail-actions"><button className="detail-primary" onClick={()=>desktopApi.openWeb('/assistant')}>{t('detail.askAssistant')}</button><button className="detail-secondary" onClick={()=>desktopApi.openWeb('/portfolio')}>{t('detail.viewWeb')} <ExternalLink size={13}/></button></div>
  </aside>
}
