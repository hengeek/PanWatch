const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const {createRequire} = require('node:module');
const requireFrontend = createRequire(require('node:path').resolve(__dirname, '../../frontend/package.json'));
const {JSDOM} = requireFrontend('jsdom');
function setup() {
  const dom = new JSDOM(fs.readFileSync(`${__dirname}/../PanWatch/Resources/watch.html`, 'utf8'), {pretendToBeVisual:true});
  const context = vm.createContext({document:dom.window.document, window:{webkit:{messageHandlers:{api:{postMessage(){}}}}}, setTimeout:()=>1,clearTimeout(){},setInterval(){},console});
  vm.runInContext(fs.readFileSync(`${__dirname}/../PanWatch/Resources/watch.js`,'utf8'),context);
  return {run: code=>vm.runInContext(code,context),document:dom.window.document};
}
const fixture = `
portfolio={accounts:[{id:1,name:'长线',positions:[{symbol:'00700',market:'HK',name:'腾讯',cost_price:300,quantity:100}]},{id:2,name:'美股',positions:[{symbol:'AAPL',market:'US',name:'苹果',cost_price:100,quantity:10}]}],exchange_rates:{HKD_CNY:0.9,USD_CNY:7}};
quotes=new Map([['HK:00700',{current_price:330,change_pct:10,quote_date:'2026-11-09',daily_move_status:'current'}],['US:AAPL',{current_price:110,change_pct:10,quote_date:'2026-11-09',daily_move_status:'current'}]]);
markets=new Map([['HK',{status:'open',local_date:'2026-11-09'}],['US',{status:'open',local_date:'2026-11-09'}]]);
connected=true;
`;
test('人民币汇总并保留原币成本，账户筛选隔离',()=>{
 const {run,document}=setup();run(fixture+'render()');
 assert.equal(document.getElementById('value').textContent,'37,400.00');
 assert.equal(document.getElementById('pnl').textContent,'+3,400.00');
 run("selection='account:1';render()");assert.equal(document.querySelectorAll('tbody tr').length,1);
 assert.equal(document.getElementById('value').textContent,'29,700.00');
});
test('休市和过期行情不复活当日涨幅',()=>{
 const {run}=setup();run(fixture);
 run("markets.get('HK').status='closed'");assert.equal(run('position(portfolio.accounts[0].positions[0], "长线").daily'),null);
 run("markets.get('HK').status='open';quotes.get('HK:00700').quote_date='2026-11-08'");assert.equal(run('quoteFor(portfolio.accounts[0].positions[0]).change'),null);
});
test('汇率和现价缺失时不编造汇总',()=>{
 const {run,document}=setup();run(fixture+"delete portfolio.exchange_rates.HKD_CNY;render()");
 assert.equal(document.getElementById('value').textContent,'—');
 assert.equal(run('position(portfolio.accounts[0].positions[0], "长线").pnl'),null);
});
test('自选按市场分组，搜索支持代码且名称按文本渲染',()=>{
 const {run,document}=setup();run(fixture+"stocks=[{name:'<script>test</script>',symbol:'00700',market:'HK'},{name:'苹果',symbol:'AAPL',market:'US'}];selection='market:HK';render()");
 assert.equal(document.querySelectorAll('tbody tr').length,1);assert.equal(document.querySelector('tbody script'),null);
 assert.equal(document.getElementById('pnl').textContent,'—');
 document.getElementById('search').value='AAPL';run('render()');assert.equal(document.querySelectorAll('tbody tr').length,0);
});
test('刷新失败保留上次表格并显示错误',async()=>{
 const {run,document}=setup();run(fixture+'render();api=async()=>{throw new Error("离线")};');
 await run('refresh()');assert.equal(document.querySelectorAll('tbody tr').length,2);
 assert.equal(document.getElementById('notice').hidden,false);assert.match(document.getElementById('notice').textContent,/离线/);
});
