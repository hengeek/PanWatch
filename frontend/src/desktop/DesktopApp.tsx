import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Bell, BellRing, ChevronDown, HelpCircle, Clock3, Eye, EyeOff, ExternalLink, FolderPlus, LayoutDashboard, LineChart, ListFilter, LockKeyhole, RefreshCw, Search, Settings2, Star, TrendingUp, X } from 'lucide-react'
import { desktopApi, type KlineResponse, type Market, type Portfolio, type Quote, type Stock } from './api'
import type { WatchGroup } from '@panwatch/api/watch-groups'

type Group = { id: string; name: string; count: number }
type PositionRow = NonNullable<Portfolio['accounts'][number]['positions'][number]> & { accountId: number; accountName: string }
type MarketMap = Record<string, Market>
const MARKET_NAMES: Record<string, string> = { CN: 'A 股', HK: '港股', US: '美股' }
const fmt = (n: number | null | undefined, digits = 2) => n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const money = (n: number | null | undefined) => n == null ? '—' : `¥${fmt(n)}`
const percent = (n: number | null | undefined) => n == null ? '—' : `${n > 0 ? '+' : ''}${fmt(n)}%`
const cls = (n: number | null | undefined) => n == null || n === 0 ? 'flat' : n > 0 ? 'gain' : 'loss'
const validToday = (row: Quote | undefined, market: Market | undefined) => !!row && row.daily_move_status === 'current' && !!market && market.status === 'trading' && (!row.quote_date || row.quote_date === market.local_date)

export default function DesktopApp() {
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
      { id: 'all', name: '全部持仓', count: rows.length },
      ...(portfolio?.accounts ?? []).map(account => ({ id: `account:${account.id}`, name: account.name, count: account.positions.length })),
      { id: 'watch', name: '全部关注', count: stocks.length },
      ...[...new Set(stocks.map(stock => stock.market))].map(market => ({ id: `market:${market}`, name: `${MARKET_NAMES[market] ?? market}关注`, count: stocks.filter(s => s.market === market).length })),
      ...watchGroups.map(group => ({ id: `custom:${group.id}`, name: group.name, count: group.members.length })),
    ]
    return next
  }, [portfolio, rows.length, stocks, watchGroups])

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
      setNotice(''); setUpdated(new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))
    } catch (error) {
      setNotice(`刷新失败：${error instanceof Error ? error.message : '服务暂不可用'}。保留最近一次数据。`)
    } finally { setBusy(false) }
  }, [connected, busy])

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
    catch (error) { setNotice(error instanceof Error ? error.message : '分组创建失败') }
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
      await loadGroups(); setMemberDialog(false); setNotice('关注分组已更新')
    } catch (error) { setNotice(error instanceof Error ? error.message : '分组同步失败，请刷新后重试') }
    finally { setGroupBusy(false) }
  }

  const connect = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setLoginError('')
    try {
      await desktopApi.connect(server.trim(), username.trim(), password)
      setPassword(''); setConnected(true)
    } catch (error) { setLoginError(error instanceof Error ? error.message : '连接失败，请检查地址与服务状态') }
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
    return { key: `${stock.market}:${stock.symbol}`, stock, price: quote?.current_price ?? null, change: validToday(quote, markets[stock.market]) ? quote?.change_pct ?? null : null, pnl: null, pnlPct: null, cnyValue: null, shares: null as number | null, cost: null as number | null, accountName: '关注', market: stock.market }
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

  if (!connected) return <main className="connect-screen"><section className="connect-card"><div className="wordmark"><span><TrendingUp size={19}/></span> PANWATCH / DESKTOP</div><h1>把目光，留给持仓。</h1><p>连接现有 PanWatch 服务，读取持仓、关注股票和行情。密码不会保存在桌面页面中。</p><form onSubmit={connect}>
    <label>服务地址<input required type="url" value={server} onChange={event => setServer(event.target.value)} placeholder="http://127.0.0.1:8000" /></label>
    <label>用户名<input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} /></label>
    <label>密码<input required autoComplete="current-password" type="password" value={password} onChange={event => setPassword(event.target.value)} /></label>
    {loginError && <div role="alert" className="inline-error">{loginError}</div>}
    <button className="primary wide" disabled={busy}>{busy ? '正在检查服务…' : '连接并读取股票'}</button>
  </form></section></main>

  return <main className="desktop-shell">
    <header className="topbar"><div className="titlemark"><span className="mark"><TrendingUp size={16}/></span><b>PanWatch</b><span className="desk-tag">DESKTOP</span></div>
      <nav className="topnav"><button className="nav-active"><LayoutDashboard size={15}/>盯盘</button><button onClick={() => setNotice('消息中心将在下一步接入现有通知记录。')}><Bell size={15}/>消息{unread > 0 && <i>{unread}</i>}</button><button onClick={() => setNotice('组合诊断接入安排在 V0.4。')}><Activity size={15}/>组合</button></nav>
      <div className="top-actions"><button className="icon-button" title={privacy ? '显示金额' : '隐藏金额'} onClick={() => { setPrivacy(!privacy); desktopApi.setPrivacy(!privacy) }}>{privacy ? <EyeOff/> : <Eye/>}</button><button className="quiet-button" onClick={() => setNotice('迷你窗口将在后续 Mac 原生体验阶段接入。')}>□ <span>迷你窗口</span></button><button className="icon-button" title="连接设置" onClick={() => setShowSettings(true)}><Settings2/></button></div>
    </header>
    <section className="summarybar"><button className="account-select" onClick={() => setSelection('all')}><ChevronDown size={14}/>{selection.startsWith('account:') ? portfolio?.accounts.find(a=>String(a.id)===selection.slice(8))?.name ?? '全部账户' : '全部账户'}</button><div className="metric"><label>持仓市值</label><strong>{privacy ? '••••••' : money(totalValue)}</strong></div><div className="metric"><label>浮动盈亏</label><strong className={cls(totalPnl)}>{privacy ? '••••••' : money(totalPnl)}</strong></div><div className="metric"><label>当日盈亏</label><strong className={cls(totalDaily)}>{privacy ? '••••••' : money(totalDaily)}</strong></div><div className="market-status"><span className={activeMarket ? 'status-dot live' : 'status-dot'}/>{activeMarket ? `${activeMarket.name} ${activeMarket.status_text} · ${activeMarket.local_time ?? ''}` : '各市场休市'}</div></section>
    <div className="content-grid"><aside className="sidebar"><div className="side-heading">我的持仓</div><GroupButton group={{id:'all',name:'全部持仓',count:rows.length}} selected={selection==='all'} onSelect={setSelection}/>{(portfolio?.accounts??[]).map(account=><GroupButton key={account.id} group={{id:`account:${account.id}`,name:account.name,count:account.positions.length}} selected={selection===`account:${account.id}`} onSelect={setSelection}/>) }
      <div className="side-rule"/><div className="side-heading side-heading-space">我的关注 <button className="add-group" onClick={()=>groupsReady?setGroupDialog(true):setNotice('当前服务尚未提供自定义分组接口，请更新并重启 PanWatch 服务。')} aria-label="新增关注分组"><FolderPlus size={15}/></button></div>
      <GroupButton group={{id:'watch',name:'全部关注',count:stocks.length}} selected={selection==='watch'} onSelect={setSelection}/>{[...new Set(stocks.map(s=>s.market))].map(market=><GroupButton key={market} group={{id:`market:${market}`,name:`${MARKET_NAMES[market]??market}观察`,count:stocks.filter(s=>s.market===market).length}} selected={selection===`market:${market}`} onSelect={setSelection}/>)}{watchGroups.map(group=><GroupButton key={group.id} group={{id:`custom:${group.id}`,name:group.name,count:group.members.length}} selected={selection===`custom:${group.id}`} onSelect={setSelection}/>) }
      <div className="side-rule"/><div className="side-heading">智能筛选</div><button className="group-button" onClick={()=>{setSelection('all');setQuery('')}}><ListFilter size={15}/><span>全部筛选</span><small>⌘K</small></button><button className="group-button" onClick={()=>desktopApi.openWeb('/alerts')}><BellRing size={15}/><span>今日提醒</span><small>{unread || ''}</small></button>
      <div className="sidebar-bottom"><div><span className={notice?'status-dot':'status-dot live'}/>{notice?'服务状态待检查':'已连接 PanWatch'}</div><small>{updated ? `更新于 ${updated}` : '等待行情数据'}</small></div>
    </aside>
    <section className="watch-area"><div className="list-toolbar"><div><span className="eyebrow">WATCHLIST / 01</span><h1>{groupsForScreen.find(group=>group.id===selection)?.name ?? '全部持仓'}<small>{currentItems.length} 项</small></h1></div><div className="toolbar-actions"><label className="search-field"><Search size={15}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索名称 / 代码"/><kbd>⌘F</kbd></label><button className="outline-button" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={14} className={busy?'spin':''}/></button><button className="outline-button" onClick={()=>setNotice('列设置将在主列表完成后接入。')}><Settings2 size={15}/>列</button></div></div>
      {notice && <div className="notice-banner" role="status"><HelpCircle size={15}/><span>{notice}</span><button onClick={()=>setNotice('')} aria-label="关闭提示"><X size={15}/></button></div>}
      <div className="stock-table-wrap"><table className="stock-table"><thead><tr><th>股票</th><th>现价</th><th>涨跌幅</th><th>近20日</th><th>浮动盈亏</th><th>仓位</th></tr></thead><tbody>{currentItems.map(row=>{const picked = row.key===selectedRow?.key;return <tr key={row.key} onClick={()=>setSelectedKey(row.key)} className={picked?'selected-row':''}><td className="stock-name"><b>{row.stock.name}</b><small>{row.market} {row.stock.symbol}{!isWatch?` · ${row.accountName}`:''}</small></td><td className="num">{privacy?'••••':fmt(row.price)}</td><td className={`num ${cls(row.change)}`}>{percent(row.change)}</td><td><Sparkline values={selectedRow?.key===row.key ? (detail?.klines?.map(item=>item.close)??[]) : []} change={row.change}/></td><td className={`num ${cls(row.pnl)}`}>{privacy?'••••':money(row.pnl)}</td><td className="num">{isWatch?'—':row.cnyValue!=null&&portfolio?.total.total_market_value ? `${fmt(row.cnyValue/portfolio.total.total_market_value*100)}%`:'—'}</td></tr>})}</tbody></table>
        {!currentItems.length && <div className="empty-state"><div>◎</div><b>{query?'没有匹配的股票':'这个分组还没有股票'}</b><span>{query?'换个名称或代码试试':'可先在 PanWatch 网页维护持仓与关注列表'}</span></div>}
      </div><div className="table-foot"><span>持仓盈亏按人民币汇总 · 个股价格显示原币</span><span>{currentItems.length} / {isWatch?stocks.length:positions.length}</span></div>
    </section>
    <StockDetail row={selectedRow} quote={selQuote} market={selectedRow?markets[selectedRow.market]:undefined} klines={detail} loading={detailBusy} isWatch={isWatch} privacy={privacy} watchGroups={watchGroups} groupsReady={groupsReady} onEditGroups={() => { setMemberSelections(watchGroups.filter(group=>group.members.some(member=>member.stock_id===selectedRow?.stock.id)).map(group=>group.id)); setMemberDialog(true) }} />
    </div>
    <footer className="app-footer"><span><span className="status-dot live"/> 已连接 PanWatch</span><span><Clock3 size={13}/>{autoRefresh?'30秒刷新':'自动刷新已暂停'} · 行情可能存在延迟</span><button onClick={()=>setAutoRefresh(!autoRefresh)}>{autoRefresh?'暂停刷新':'恢复刷新'}</button></footer>
    {groupDialog && <div className="modal-backdrop" onClick={()=>setGroupDialog(false)}><form className="settings-panel" onSubmit={createGroup} onClick={event=>event.stopPropagation()}><header><div><span className="eyebrow">WATCH GROUP</span><h2>新建关注分组</h2></div><button type="button" className="icon-button" onClick={()=>setGroupDialog(false)}><X/></button></header><p>分组保存在 PanWatch 服务中，网页和桌面端共用。</p><label>分组名称<input autoFocus maxLength={40} required value={groupName} onChange={event=>setGroupName(event.target.value)} placeholder="例如：长期观察"/></label><button className="primary wide" disabled={groupBusy}>{groupBusy?'保存中…':'创建分组'}</button></form></div>}
    {memberDialog && <div className="modal-backdrop" onClick={()=>setMemberDialog(false)}><section className="settings-panel group-members-panel" onClick={event=>event.stopPropagation()}><header><div><span className="eyebrow">WATCH GROUP</span><h2>选择关注分组</h2></div><button className="icon-button" onClick={()=>setMemberDialog(false)}><X/></button></header><p>{selectedRow?.stock.name} 可同时加入多个分组。</p>{watchGroups.map(group=><label className="member-choice" key={group.id}><input type="checkbox" checked={memberSelections.includes(group.id)} onChange={event=>setMemberSelections(current=>event.target.checked?[...current,group.id]:current.filter(id=>id!==group.id))}/><span>{group.name}</span><small>{group.members.length} 只</small></label>)}{watchGroups.length===0&&<div className="empty-state">先创建一个关注分组</div>}<button className="primary wide" disabled={groupBusy||watchGroups.length===0} onClick={()=>void saveGroupMembers()}>{groupBusy?'同步中…':'保存分组'}</button></section></div>}
    {showSettings && <div className="modal-backdrop" onClick={()=>setShowSettings(false)}><section className="settings-panel" onClick={event=>event.stopPropagation()}><header><div><span className="eyebrow">CONNECTION</span><h2>服务连接</h2></div><button className="icon-button" onClick={()=>setShowSettings(false)}><X/></button></header><p>桌面端读取你现有的 PanWatch 数据。</p><label>服务地址<input value={server} onChange={event=>setServer(event.target.value)}/></label><div className="settings-meta"><LockKeyhole size={15}/>密码不保存在桌面页面中</div><button className="primary wide" onClick={()=>{setShowSettings(false);window.panWatchDesktop?.request('logout');setConnected(false);setPortfolio(null);setStocks([]);setWatchGroups([]);setQuotes({});setMarkets({});}}>更换账号或服务</button></section></div>}
  </main>
}

function GroupButton({group,selected,onSelect}:{group:Group;selected:boolean;onSelect:(id:string)=>void}) {
  return <button className={`group-button ${selected?'group-selected':''}`} onClick={()=>onSelect(group.id)}><span className="group-glyph">{group.id==='all'?'▤':group.id.startsWith('account:')?'▱':group.id==='watch'?'☆':'◇'}</span><span>{group.name}</span><small>{group.count}</small></button>
}

function Sparkline({values,change}:{values:number[];change:number|null}) {
  if(values.length<2) return <span className="spark-empty" aria-label="走势暂不可用">—</span>
  const min=Math.min(...values), max=Math.max(...values), range=max-min||1
  const points=values.map((value,index)=>`${(index/(values.length-1))*100},${36-((value-min)/range)*30}`).join(' ')
  return <svg className={`spark ${cls(change)}`} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true"><polyline points={points}/></svg>
}

function StockDetail({row,quote,market,klines,loading,isWatch,privacy,watchGroups,groupsReady,onEditGroups}:{row:any;quote:Quote|undefined;market:Market|undefined;klines:KlineResponse|null;loading:boolean;isWatch:boolean;privacy:boolean;watchGroups:WatchGroup[];groupsReady:boolean;onEditGroups:()=>void}) {
  if(!row)return <aside className="detail-pane detail-empty"><LineChart size={22}/><span>选择一只股票查看详情</span></aside>
  const points=klines?.klines?.map(k=>k.close).filter(value=>Number.isFinite(value))??[]
  const hasPoints=points.length>2
  const min=hasPoints?Math.min(...points):0,max=hasPoints?Math.max(...points):1,range=max-min||1
  const line=hasPoints?points.map((value,index)=>`${(index/(points.length-1))*420},${178-((value-min)/range)*154}`).join(' '):''
  const area=hasPoints?`0,180 ${line} 420,180`:''
  const conditionValid=validToday(quote,market)
  return <aside className="detail-pane"><div className="detail-head"><div><span className="eyebrow">STOCK / DETAIL</span><h2>{row.stock.name}</h2><p>{MARKET_NAMES[row.market]??row.market} {row.stock.symbol} <span>· {row.market==='HK'?'港元':row.market==='US'?'美元':'人民币'}</span></p></div><button className="icon-button" title="置顶股票"><Star size={17}/></button></div>
    <div className="price-line"><b>{privacy?'••••••':fmt(row.price)}</b><span className={`change-pill ${cls(conditionValid?quote?.change_pct:null)}`}>{conditionValid?percent(quote?.change_pct):'—'}</span></div><div className="quote-meta">{market?.status_text??'市场状态未知'} · 报价日期 {quote?.quote_date??'暂无'}</div>
    <div className="chart-card"><div className="chart-title"><b>近20个交易日</b><span>{loading?'读取中':points.length?'日线':'走势暂不可用'}</span></div>{hasPoints?<svg viewBox="0 0 420 210" preserveAspectRatio="none" className="detail-chart"><defs><linearGradient id="chartfill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#2f795e" stopOpacity=".2"/><stop offset="1" stopColor="#2f795e" stopOpacity="0"/></linearGradient></defs><path d={`M ${area.replace(/ /g, ', ')} Z`} fill="url(#chartfill)"/><polyline points={line} fill="none" stroke="#32785e" strokeWidth="2.3" strokeLinejoin="round"/></svg>:<div className="chart-placeholder"><LineChart size={19}/><span>{loading?'正在读取日线行情':'数据源暂未提供走势'}</span></div>}</div>
    <section className="detail-section"><div className="section-title"><b>我的持仓</b><button className="text-button">{isWatch?'关注股票':'账户明细'}</button></div>{isWatch?<div className="holding-row"><span>当前未持仓</span><span>—</span></div>:<><div className="holding-row"><span>所属账户</span><b>{row.accountName}</b></div><div className="holding-row"><span>成本价 / 持仓</span><b>{privacy?'••••':`${fmt(row.cost)} / ${row.shares?.toLocaleString('zh-CN')??'—'} 股`}</b></div><div className="holding-row"><span>浮动盈亏</span><b className={cls(row.pnl)}>{privacy?'••••':money(row.pnl)}</b></div><div className="holding-row"><span>当日盈亏</span><b className={cls(conditionValid?row.daily_pnl:null)}>{privacy?'••••':conditionValid?money(row.daily_pnl):'—'}</b></div></>}</section>
    <section className="detail-section"><div className="section-title"><b>关注分组</b><span className="micro-tag">与网页同步</span></div><p className="detail-note">{watchGroups.filter(group=>group.members.some(member=>member.stock_id===row.stock.id)).map(group=>group.name).join(' · ') || '尚未加入自定义关注组'}</p><button className="add-alert" onClick={onEditGroups} disabled={!groupsReady}>＋ 编辑所属分组</button></section>
    <section className="detail-section report-section"><div className="section-title"><b>最新分析</b><span className="micro-tag">报告入口</span></div><p className="detail-note">读取网页中已有的分析报告与研究记录。</p><button className="report-link" onClick={()=>desktopApi.openWeb('/portfolio')}>打开网页查看 <ExternalLink size={13}/></button></section>
    <div className="detail-actions"><button className="detail-primary" onClick={()=>desktopApi.openWeb('/assistant')}>询问助手</button><button className="detail-secondary" onClick={()=>desktopApi.openWeb('/portfolio')}>网页查看 <ExternalLink size={13}/></button></div>
  </aside>
}
