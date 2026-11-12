# 设计源文件

本目录保存 pen.dev 可编辑设计源文件（`.pen`）。评审和文档使用的导出图放在 [../prototypes/](../prototypes/)，不在这里重复维护。

| 文件 | 内容 | 画布 |
|---|---|---|
| [panwatch-macos-client-v2.pen](panwatch-macos-client-v2.pen) | macOS 客户端主设计：盯盘、消息、组合、迷你窗口、菜单栏、连接页，以及行情中心、个股详情和行情子页 | 1586×992 |
| [panwatch-web-client.pen](panwatch-web-client.pen) | Web 客户端：首页、持仓、机会、助手、模拟盘、左侧策略、登录，以及复用组件 | 1180 宽 |

## 使用约定

- 用 pen.dev 打开和修改，不要用文本编辑器直接改 `.pen`。
- `.pen` 是设计事实源；PNG 只是导出物，用于评审、文档和无法打开 pen.dev 的场景。
- 修改设计后同步导出受影响页面的 PNG 到 `docs/prototypes/`，并更新引用它的需求/实施文档。
- 不把第三方原型的页面截图或素材直接放进本目录；只保留自行重绘的设计稿。

## macOS 画布索引

`panwatch-macos-client-v2.pen` 还保留少量早期 Web 画面；Web 端以 `panwatch-web-client.pen` 为准。

| 帧 ID | 页面 | 尺寸 |
|---|---|---|
| `rGKi7` | macOS · 行情盯盘 | 1586×992 |
| `T3rx9` | macOS · 消息中心 | 1586×992 |
| `ack8Q` | macOS · 组合分析 | 1586×992 |
| `VEsGd` | macOS · 迷你盯盘 | 360×448 |
| `dkWwt` | macOS · 迷你盯盘 · 关注 | 360×448 |
| `Y7k8C` | macOS · 菜单栏弹出 | 1440×900 |
| `EpCPT` | macOS · 连接 PanWatch | 1220×760 |
| `Im6Ct` | macOS · 行情中心 | 1586×992 |
| `X7FZDU` | macOS · 个股详情 | 1586×992 |
| `GtQzz` | macOS · 行情中心 V2 | 1586×992 |
| `C9PpY2` | 行情中心 · 市场总览 | 1586×992 |
| `a9EZiL` | 行情中心 · 指数行情 | 1586×992 |
| `gDBa7` | 行情中心 · 股票热榜 | 1586×992 |
| `jUgIS` | 行情中心 · 行业概念 | 1586×992 |
| `jFX6U` | 行情中心 · 涨跌分布 | 1586×992 |
| `t85QeG` | 行情中心 · 涨跌停 | 1586×992 |
| `r0Wo19` | 行情中心 · 龙虎榜 | 1586×992 |
| `y22z2x` | 行情中心 · 资金流向 | 1586×992 |
| `HWjas` | 行情中心 · T+0 ETF | 1586×992 |

## Web 画布索引

| 帧 ID | 页面/组件 | 尺寸 |
|---|---|---|
| `eTouD` | Web · 首页 | 1180×1171 |
| `Vt4Iq` | Web · 持仓 | 1180×1036 |
| `CoyJB` | Web · 机会 | 1180×1133 |
| `D1D5f` | Web · 助手 | 1180×820 |
| `mQ5OJ` | Web · 模拟盘 | 1180×1785 |
| `h2207` | Web · 左侧策略 | 1180×1035 |
| `rFP5v` | Web · 登录 | 1180×820 |
| `h3IG3h` | Component · Site Header | 1180×82 |
| `HUNFQ` | Component · Metric Card | 272×111 |
| `k6rWxR` | Component · Rank Row | 1132×56 |
| `s3R3pn` | Component · Rank Table Head | 1132×34 |
| `OMx0q` | Component · Status Chip | 50×24 |
| `AtbaK` | Component · Filter Chip | 73×32 |
