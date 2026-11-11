# PanWatch macOS 盯盘

PanWatch for macOS 是 Swift / AppKit + WKWebView 外壳与 React / TypeScript 页面组成的桌面客户端。它连接你已有的 PanWatch 服务，不会在 Mac 上另建一份持仓数据库，也不会自动连接券商或下单。

## 安装 DMG

1. 启动已有 PanWatch 服务；本机默认地址为 `http://127.0.0.1:8000`。
2. 打开 `PanWatch-版本号-架构.dmg`，将 PanWatch 拖到 Applications。
3. 从 Applications 或 Dock 启动，填写服务地址、用户名和密码。
4. 可勾选“保持登录”；桌面端只把服务令牌存入 macOS 钥匙串，不保存密码。取消勾选时令牌只留在内存中。
5. 将 PanWatch 固定到 Dock。关闭窗口后应用继续驻留；点击 Dock 恢复，⌘Q 完全退出。

本机构建使用临时签名。首次从 DMG 启动若 macOS 阻止打开，在 Finder 中按住 Control 点击应用并选择“打开”。跨设备公开分发需要 Developer ID 签名和公证；可通过 `PANWATCH_SIGN_IDENTITY` 与 `PANWATCH_NOTARY_PROFILE` 配置后生成正式包。

## 已接入能力

- 持仓、账户、自选、A 股 / 港股 / 美股分组与行情，支持搜索、排序和自定义列。
- 与网页版共用的自定义关注分组：创建、改名、排序、增删成员，网页和 Mac 可相互读取。
- 股票日线详情、账户持仓明细、价格提醒编辑 / 暂停、已有研究建议与网页入口。
- 股票详情展示服务端最新关联策略信号，并标注策略快照日期与来源。
- 通知中心、未读同步、可选 macOS 通知；隐私模式覆盖主窗口、菜单栏与迷你窗口。
- 组合集中度、收益贡献、基准比较，以及用户点击后才运行的 AI 组合复盘。
- 菜单栏、迷你置顶窗口、⌥⌘P 快捷键、可选开机启动。

分时数据是否可用取决于服务端接入的数据源；当前不以日线或模拟曲线替代分时行情。行情延迟、休市、缺失汇率和服务断线会在界面中标出。

## 构建

在 macOS 安装 Xcode Command Line Tools、Node / pnpm 后，在仓库根目录运行：

```sh
./macos/build.sh
open macos/build/PanWatch.app
./macos/package-dmg.sh
```

构建产物在 `macos/build/`。本轮支持当前 Mac 的 arm64 或 x86_64 单架构构建，最低声明 macOS 12。开机启动注册使用 macOS 13+ 系统登录项；macOS 12 上该设置会提示不支持。`package-dmg.sh` 默认制作本机试装包；配置签名与公证资料后可制作正式分发包。

持仓和自选数据从现有 PanWatch 服务读取；首次使用必须先运行该服务并已有账号。关注分组使用服务端 v148 数据迁移；升级部署前应按 PanWatch 服务端备份流程备份数据库。

## 地址错误排查

本机 PanWatch 默认使用 `http://127.0.0.1:8000`。如果填写其他应用占用的端口（例如本机 `8080` 的 LingOps 页面），接口可能返回 HTML，无法用于登录。应用会在提交账号密码前检查 `/api/auth/status`，明确提示端口不匹配；不会自动切换到另一服务。
