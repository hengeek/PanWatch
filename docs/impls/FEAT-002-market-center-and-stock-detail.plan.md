# FEAT-002 行情中心与个股详情实施计划

状态：proposed  
更新时间：2026-11-12  
需求：[FEAT-002 行情中心与个股详情](../features/FEAT-002-market-center-and-stock-detail.md)  
设计稿：[行情中心](../prototypes/macos-market-center-v1.png) · [个股详情](../prototypes/macos-stock-detail-v1.png)  
负责人：待确认

## 1. 实施原则

1. **先交付可用的真实数据，再补空态模块。** P0 只使用现有接口；没有数据源的模块显示「待接入」，不进入业务计算。
2. **不伪造行情。** 生产代码不允许随机数、写死价格、模拟分时或把示例数据当默认值；测试夹具只能存在于测试目录。
3. **依赖方向不变。** `web → modules → platform`；供应商适配放在 `packages/marketdata` 或 `src/platform/marketdata`，HTTP 路由只做参数校验与 DTO 转换。
4. **交易日与数据时间显式化。** 每个响应带 `as_of` / `trade_date` / `source` / `stale` 等语义字段，前端按状态展示。
5. **按现有 macOS 入口实现。** 继续使用 `frontend/src/desktop/DesktopApp.tsx` 与桌面 API 适配，不新建 Electron/Tauri 壳，不复制网页导航。

## 2. 阶段划分

### P0：用现有数据交付行情中心与详情骨架

目标：不改行情供应商，先把页面结构、导航、真实指数/板块/热榜/报价/K 线跑通。

后端：

- 不新增供应商。
- 复用 `/api/market/indices`、`/api/discovery/boards`、`/api/discovery/stocks`、`/api/quotes/{symbol}`、`/api/quotes/batch`、`/api/klines/{symbol}`。
- 如需减少桌面端拼接，可新增只读聚合接口 `GET /api/market/stock/{symbol}/overview?market=CN`，内部调用现有 quote + kline + fundamentals service；不得在路由里直接请求供应商。
- `Quote` 响应已包含开高低收、成交量/额、换手率、量比、PE、总市值、流通市值；检查各供应商实际覆盖并保留 `None`。

桌面端：

- 顶部导航新增「行情」（待 D1 确认）；保持「盯盘 / 消息 / 组合」原行为。
- 新增 `frontend/src/desktop/pages/MarketCenter.tsx`、`StockDetail.tsx` 及卡片/表格组件。
- `frontend/src/desktop/api.ts` 增加 `marketIndices`、`discoveryStocks`、`discoveryBoards` 方法；扩展 `Quote` 类型与 `KlineResponse`（保留可选字段，兼容旧响应）。
- 图表复用真实日线：蜡烛、MA5/10/20、成交量、MACD 在前端计算；周期切换调用 `/api/klines?interval=1d|1w|1m`。
- 分时标签禁用；涨跌分布、涨跌停、资金流向、龙虎榜、T+0 ETF、F10、研究笔记按设计显示「待接入」区域或折叠。
- 新增中英文 i18n 文案；所有用户可见字符串必须同时更新 `zh-CN` 与 `en-US` 资源。
- 1180×780 下按 15% / 58% / 27% 三栏收敛；右栏可折叠；无横向滚动。

P0 验收：AC-01、AC-02、AC-03、AC-04、AC-09、AC-10、AC-11、AC-12、AC-13 中适用于现有数据的部分。

### P1：把已有平台数据暴露为结构化 API

目标：龙虎榜、资金流向、北向资金、估值字段进入页面；不改供应商。

后端：

- 在 `src/modules/market/services/` 新增服务（或现有 market service 扩展），封装 `MarketData`：
  - `GET /api/market/dragon-tiger?date=YYYY-MM-DD&market=CN`
  - `GET /api/market/capital-flow/{symbol}?market=CN`
  - `GET /api/market/northbound`
  - `GET /api/market/stock/{symbol}/overview?market=CN`（若 P0 未做）
- DTO 必须是模块自有 Pydantic 模型，不把 `packages/marketdata` dataclass 或供应商 dict 直接返回。
- 每个响应包含：`market`、`symbol`（如适用）、`trade_date`/`as_of`、`source`、`stale`、`items`/字段值。
- 路由加认证依赖；公共指数保持公开；错误使用 `api_error`，区分 `*_unavailable` 与 `*_unsupported`。
- 缓存建议：龙虎榜按交易日 300s；资金流盘中 30–60s、收盘后 300s；北向 60s。缓存实现放在 platform 适配层或模块 service，不在路由里复制。
- 字段校准：`DragonTigerItem` / `CapitalFlow` 中标注「待实抓校准」的字段，先用真实响应核对并记录样本日期；未核对的字段返回 `None`，前端显示「—」。

桌面端：

- 龙虎榜卡片接真实交易日数据；资金流向卡片接个股资金流；详情页资金/龙虎榜标签启用。
- 右栏增加总市值、流通市值、PE、PB、换手率、量比；52 周高低与年初至今仅在能由真实日线计算时显示。
- 数据时间与交易日显示在卡片标题或脚注。

P1 验收：AC-06、AC-07、AC-09 的扩展字段；以及 AC-13。

### P2：需要新数据源或新存储的模块

按 D2–D7 的决策逐项立项，不一次性全部启动：

| 能力 | 需要的改动 | 前置决策 |
|---|---|---|
| 涨跌分布 | 新增市场宽度快照源/DTO；全市场一致快照与缓存 | D3 |
| 涨跌停 | 涨停池/跌停池/炸板率/连板高度；ST、北交所、20cm 口径 | D3 |
| 人气榜 | 新热度/关注度数据源；定义排名口径 | D2 |
| T+0 ETF | ETF 目录 + T+0 分类规则与生效日期；免责声明 | D5 |
| 分钟 K 线 | 供应商接入、交易时段、缺口、缓存、保留期、频率；`/api/klines` 增加 `1m/5m/15m/30m/60m` | D6 |
| F10/公司简介 | 外部数据源或人工维护；缓存与来源标识 | D7 |
| 研究笔记 | 新表 + 迁移 + API + 桌面编辑；与网页同步 | D7 |

P2 不允许用「先写死示例值」的方式提前上线。

## 3. 建议的 API 契约

仅列新增或需要明确的接口；现有 `/api/market/indices`、`/api/discovery/*`、`/api/quotes/*`、`/api/klines/*` 保持兼容。

```http
GET /api/market/capital-flow/600519?market=CN
```

```json
{
  "symbol": "600519",
  "market": "CN",
  "as_of": "2026-11-12T10:32:06+08:00",
  "trade_date": "2026-11-12",
  "source": "eastmoney",
  "stale": false,
  "main_net_inflow": 386000000.0,
  "main_net_inflow_pct": null,
  "super_net_inflow": 214000000.0,
  "big_net_inflow": 172000000.0,
  "mid_net_inflow": -86000000.0,
  "small_net_inflow": -123000000.0,
  "main_net_5d": null
}
```

```http
GET /api/market/dragon-tiger?date=2026-11-11&market=CN
```

```json
{
  "market": "CN",
  "trade_date": "2026-11-11",
  "as_of": "2026-11-12T08:30:00+08:00",
  "source": "eastmoney",
  "stale": false,
  "items": [
    {
      "symbol": "300308",
      "name": "中际旭创",
      "reason": "日涨幅偏离值达 7%",
      "close": null,
      "change_pct": null,
      "net_buy": null,
      "buy_amt": null,
      "sell_amt": null,
      "turnover_pct": null
    }
  ]
}
```

字段值为 `null` 表示供应商未返回或尚未校准，前端显示「—」，不得补零。

## 4. 后端落点

| 层 | 文件/位置 | 改动 |
|---|---|---|
| 供应商 | `packages/marketdata/src/marketdata/vendors/` | P1 复用现有 `capital_flow.py`、`market_flow.py`、`northbound.py`；P2 新增宽度/涨停/人气/分钟 K 线 vendor |
| 平台适配 | `src/platform/marketdata/` | 统一异常、超时、缓存、数据时间与 DTO 转换；不把供应商字段泄露到 HTTP |
| 业务服务 | `src/modules/market/services/` | 编排行情、资金、龙虎榜、详情聚合；交易日与市场状态判断 |
| HTTP | `src/modules/market/api/` | 新增路由与 Pydantic 请求/响应模型；仅参数校验与 service 调用 |
| 装配 | `src/bootstrap/application.py` | 注册新路由；不承载业务逻辑 |
| 持久化 | `src/platform/persistence/` | 仅在 P2 笔记/快照需要时增加表与可重复迁移 |

边界检查：

- 不新增 `src/collectors/`、`src/models/` 等旧目录。
- 模块之间不直接导入对方 ORM/repository/router。
- 新增模块边界时同步更新 `tests/test_architecture_boundaries.py`。
- 路由不得直接 `import marketdata` 调供应商；必须经 platform/package 适配。

## 5. 前端落点

| 位置 | 改动 |
|---|---|
| `frontend/src/desktop/DesktopApp.tsx` | 增加 `market` 视图与导航；保留 watch/messages/portfolio/mini 状态；切换页面不重置自选筛选 |
| `frontend/src/desktop/pages/MarketCenter.tsx` | 摘要栏、指数卡、行业、热榜、宽度/涨停空态、资金/龙虎/ETF |
| `frontend/src/desktop/pages/StockDetail.tsx` | 头部、自选侧栏、图表、标签内容、右栏卡片、返回 |
| `frontend/src/desktop/components/` | `KLineChart`、`Sparkline`、`DataStatus`、`RankingTable`、`MetricGrid` 等复用组件 |
| `frontend/src/desktop/api.ts` | 新 API 方法与扩展类型；统一错误/超时/取消 |
| `frontend/src/desktop/desktop.css` | 沿用现有绿色 token、间距、字号；新增行情页样式 |
| `frontend/src/i18n/locales/{zh-CN,en-US}/` | 同步所有用户可见文案 |

交互与状态：

- 页面级 `AbortController`；切换股票或周期时取消旧请求。
- 加载、空、错误、过期四态统一由 `DataStatus` 组件展示。
- 行情轮询与现有桌面刷新策略一致；页面不可见时降低频率；不承诺秒级。
- 图表计算只依赖真实 bars；数据不足（如 MA20 需要 20 根）时显示空段而不是补点。

## 6. 测试与验证

| 层级 | 用例 | 要求 |
|---|---|---|
| `packages/marketdata/tests/` | 新 vendor 正常/空/字段缺失/异常响应 | mock HTTP，不访问真实网络 |
| `tests/`（market API） | DTO 字段、认证、交易日、缓存、错误码、字段为 `None` 的序列化 | monkeypatch MarketData；不实际调用供应商 |
| `tests/test_architecture_boundaries.py` | 新模块/导入边界 | 与现有边界测试一致 |
| `frontend/tests/` | 行情页渲染、空态、数据状态、切换股票取消旧请求、分时禁用、无示例数字 | Vitest + Testing Library；不依赖真实接口 |
| 人工 smoke | 1180×780、中英文、断网、休市、数据源超时、切换市场 | 按 [smoke 清单](../tests/smoke.md) 记录 PASS/FAIL/未执行 |

执行命令：

```bash
make check
make test
make verify
```

真实外部行情或付费 API 调用不在默认测试中执行；需要时另行取得授权并记录环境与时间。

## 7. 交付顺序与回滚

1. P0 页面骨架 + 现有数据 + 空态 → 评审 → 1180×780 验收。
2. P1 结构化 API + 资金/龙虎/估值 → 契约测试 → 页面接入。
3. P2 按 D2–D7 单独立项，每项独立开关/降级；分钟数据未确认前保持分时禁用。

回滚策略：

- 前端新页面通过导航开关或桌面配置控制；关闭后回到现有盯盘/详情路径。
- 新增 API 独立路由，不影响现有 `/api/quotes`、`/api/klines`、`/api/discovery` 契约。
- P2 新表使用新迁移，不修改已发布迁移；回滚只停用功能，不删用户数据。

## 8. 未决问题

与需求文档 D1–D10 相同。实施前至少确认：

- D1 导航是否新增「行情」。
- D2/D3 热榜与市场宽度/涨跌停的数据源。
- D4 龙虎榜/资金流 API 的字段校准责任人与真实样本日期。
- D5 T+0 ETF 范围。
- D6 分钟数据的供应商、授权、频率与保留期。
- D7 F10/研究笔记是否进入近期范围。
- D9 第三方原型的素材边界。

## 9. 状态记录

| 项目 | 状态 | 说明 |
|---|---|---|
| 需求与设计 | draft / proposed | 本文与 FEAT-002 已落库，待确认决策 |
| 后端实现 | 未开始 | 无代码改动 |
| 前端实现 | 未开始 | 无代码改动 |
| 测试 | 未执行 | 无新增测试 |
| 真实数据联调 | 未执行 | 未调用外部行情 |
