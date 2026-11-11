/* Bundled UI: all requests pass through the native bridge; no external content. */
const $ = id => document.getElementById(id);
let sequence = 0, pending = new Map(), connected = false, busy = false;
let portfolio = {accounts: []}, stocks = [], quotes = new Map(), markets = new Map(), selection = 'all';
function api(path, body, server) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('请求超时，请重试')); }, 35000);
    pending.set(id, {resolve, reject, timeout});
    window.webkit.messageHandlers.api.postMessage({id, path, ...(body ? {body} : {}), ...(server ? {server} : {})});
  });
}
window.receive = ({id, value, error}) => {
  const task = pending.get(id); if (!task) return;
  pending.delete(id); clearTimeout(task.timeout);
  error ? task.reject(new Error(error)) : task.resolve(value);
};
const key = s => `${s.market}:${s.symbol}`;
const number = (value, signed = false) => value == null || !Number.isFinite(value) ? '—' : `${signed && value > 0 ? '+' : ''}${value.toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
function tone(element, value) { element.className = value == null ? 'neutral' : value > 0 ? 'up' : value < 0 ? 'down' : ''; }
function quoteFor(s) {
  const q = quotes.get(key(s));
  const market = markets.get(s.market);
  const valid = q && (!q.daily_move_status || q.daily_move_status === 'current') && market && !['closed','pre_market','unknown'].includes(market.status) && (!q.quote_date || q.quote_date === market.local_date);
  return {price:q?.current_price ?? s.current_price ?? null, change:valid ? q.change_pct : null};
}
function position(p, account) {
  const {price, change} = quoteFor(p);
  const rate = p.market === 'HK' ? portfolio.exchange_rates?.HKD_CNY : p.market === 'US' ? portfolio.exchange_rates?.USD_CNY : 1;
  const cost = rate != null ? p.cost_price * p.quantity * rate : null;
  const value = rate != null && price != null ? price * p.quantity * rate : null;
  const daily = value != null && change != null && change > -100 ? value - value / (1 + change / 100) : null;
  return {...p, account, price, change, value, pnl: value != null && cost != null ? value - cost : null, daily};
}
function allPositions() { return portfolio.accounts.flatMap(a => a.positions.map(p => position(p, a.name))); }
function groupList() {
  return [{id:'all', name:'全部持仓', count:allPositions().length}, ...portfolio.accounts.map(a => ({id:`account:${a.id}`, name:a.name, count:a.positions.length})), {id:'watch',name:'全部关注',count:stocks.length}, ...[...new Set(stocks.map(s=>s.market))].map(m=>({id:`market:${m}`,name:({CN:'A 股关注',HK:'港股关注',US:'美股关注'})[m] || `${m} 关注`,count:stocks.filter(s=>s.market===m).length}))];
}
function cell(row, text, value) { const td = document.createElement('td'); td.textContent = text; if (value !== undefined) tone(td,value); row.append(td); return td; }
function render() {
  const groups = groupList(); if (!groups.some(g=>g.id===selection)) selection='all';
  $('groups').replaceChildren();
  const label = document.createElement('label');label.textContent='我的股票';$('groups').append(label);
  groups.forEach(g=>{const b=document.createElement('button'); b.className=g.id===selection?'active':'';b.setAttribute('aria-pressed',String(g.id===selection));b.textContent=g.name;const count=document.createElement('small');count.textContent=g.count;b.append(count);b.onclick=()=>{selection=g.id;render();};$('groups').append(b);});
  let items;
  const watch = selection==='watch' || selection.startsWith('market:');
  if(watch) items=stocks.filter(s=>selection==='watch'||s.market===selection.slice(7)).map(s=>({...s,...quoteFor(s),account:'关注',pnl:null,daily:null}));
  else if(selection.startsWith('account:')) {const a=portfolio.accounts.find(a=>String(a.id)===selection.slice(8));items=a.positions.map(p=>position(p,a.name));}
  else items=allPositions();
  for(const [id,field] of [['value','value'],['pnl','pnl'],['daily','daily']]) {
    const total=watch||!items.length||items.some(p=>p[field]==null)?null:items.reduce((sum,p)=>sum+p[field],0);
    $(id).textContent=number(total,id!=='value');if(id!=='value')tone($(id),total);
  }
  $('groupTitle').textContent=groups.find(g=>g.id===selection).name;
  const query=$('search').value.trim().toLowerCase();items=items.filter(s=>`${s.name} ${s.symbol}`.toLowerCase().includes(query));
  $('rows').replaceChildren();
  items.forEach(s=>{const row=document.createElement('tr');const first=cell(row,'');const name=document.createElement('strong');name.textContent=s.name;const sub=document.createElement('small');sub.textContent=`${s.market} ${s.symbol} · ${s.account}`;first.append(name,sub);cell(row,number(s.price));cell(row,s.change==null?'—':`${number(s.change,true)}%`,s.change);cell(row,number(s.pnl,true),s.pnl);cell(row,number(s.daily,true),s.daily);cell(row,watch?'—':`${number(s.cost_price)} / ${s.quantity.toLocaleString('zh-CN')}`);$('rows').append(row);});
  $('empty').hidden=items.length>0;$('empty').textContent=query?'没有匹配的股票':connected?'此分组暂无股票，请在 PanWatch 中维护':'连接后显示持仓与关注股票';
}
async function refresh() {
  if(!connected||busy||document.hidden||$('connect').open)return;
  busy=true;$('refresh').disabled=true;$('settings').disabled=true;
  try {
    const [nextPortfolio,nextStocks]=await Promise.all([api('/portfolio/summary?include_quotes=false'),api('/stocks')]);
    const items=[...new Map([...nextStocks,...nextPortfolio.accounts.flatMap(a=>a.positions)].map(s=>[key(s),{symbol:s.symbol,market:s.market}])).values()];
    const [nextQuotes,nextMarkets]=await Promise.all([items.length?api('/quotes/batch',{items}):[],api('/stocks/markets/status')]);
    portfolio=nextPortfolio;stocks=nextStocks;quotes=new Map(nextQuotes.map(q=>[key(q),q]));markets=new Map(nextMarkets.map(m=>[m.code,m]));
    render();$('notice').hidden=true;$('status').textContent=`更新于 ${new Date().toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · 北京时间`;
  } catch(e) { $('notice').textContent=`刷新失败：${e.message}。当前表格保留上次数据。`;$('notice').hidden=false;$('status').textContent='连接异常 · 数据可能已过期'; }
  finally{busy=false;$('refresh').disabled=false;$('settings').disabled=false;}
}
window.refreshIfConnected=refresh;
$('refresh').onclick=refresh;$('search').oninput=render;
$('settings').onclick=()=>$('connect').showModal();$('cancel').onclick=()=>$('connect').close();
$('login').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;$('loginError').textContent='';
  try {await api('/auth/login',{username:$('username').value,password:$('password').value},$('server').value.trim());connected=true;$('password').value='';$('connect').close();await refresh();}
  catch(e){connected=false;$('loginError').textContent=e.message;}
  finally{button.disabled=false;}
};
setInterval(()=>{if($('auto').checked&&!$('connect').open)refresh();},30000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&$('auto').checked)refresh();});
render();api('config').then(config=>{$('server').value=config.server;$('connect').showModal();});
