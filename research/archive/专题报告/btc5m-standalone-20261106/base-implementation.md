# 独立版基础移植实施与验证

实现位置：`归档目录/Trade/BTC5M-Standalone/`。原生产工作流未改、未停机；本轮不连接真实钱包，不启动第二个自动模拟。

## 已实现

- `build-base.mjs` 用白名单复制270个应用/测试/资源文件，不递归复制旧运行数据。包括124个非测试应用源码、研究静态导入闭包、强制协议JSON和29个报告JSON。
- 复制固定 terminal admission 模型到 `resources/`，保持模型哈希；从当前API仅提取运行和策略配置，写入 `paper-defaults.json`，没有复制资金、会话、订单、持仓或历史统计。
- 新入口 `app/start.mjs` 调用 `service/paths.mjs` 的 `loadStandaloneContext(root)`；支持 `startPortable({root,portOverride,recoverIntent,liveFactory,installSignals,clockFactory})`。
- 新账户明确为当前Ray策略和既有风险规则，资金0、费用0、订单0、停止且暂停。初始模拟资金由用户控制台添加；不依赖旧controller的固定成本/亏损默认值。
- 阴影观察、源码登记和归档目录均位于应用根内；旧独立研究和自动审计明确未配置，不读取原D盘研究目录，也不复制旧成功状态。
- `portableIdentity` 同时进入 `/api/state`、`/api/bootstrap`及其state、`/api/health`；另有 `/api/portable-identity`。
- `createDashboardServer` 提供可选 `extensionRouter/extensionClose`。路由在Host/Origin检查后执行，得到 `authorizeControl()` 和有16KiB上限的 `readJsonBody()`，由主代理接入真实交易模块。
- 归档支持相对清单路径及显式保护目录；继续拒绝越界、秘密和实时数据访问。
- 显式构建函数 `writeReleaseSourceManifest(root,{extraPaths})` 生成相对源码清单；启动的 `verifyReleaseSourceManifest` 核实内容、重复条目、真实路径及根目录边界。启动不会临时信任未登记代码。
- 每次启动将已核验清单解析成当前根下绝对路径，生成符合 `ray-alignment-observation-v1` 的当前会话登记；旧登记另存历史，不改原生产登记。

## 验证

`standalone-base.test.mjs` **3项通过**，每项包含多个断言：

1. 实际复制应用到C盘中文与空格路径，并从该路径导入start。校验0资金/0费用/0订单、停止、当前Ray参数、三处身份、源码登记、未配置旧观察/审计、空历史目录。测试期间拦截主要同步文件操作，启动和关闭没有读取或写入旧 `D:/Trade` 或 `D:/TradeResearch`。在隔离模拟账户添加23.45后关闭，再复制到第二个C盘目录启动，资金及会话保持、根身份变更，源码登记重新绑定新根，旧登记留档。
2. 改变源码哈希及在清单加入根外路径均在金融状态创建、校时工厂调用之前拒绝，不重建空账户掩盖问题。
3. 相对历史归档可读取，config保护及兄弟目录越界仍拒绝，原清单相对路径未被改写。

基础移位测试使用明确的live stub与 `liveFactory:()=>null`，校时使用隔离测试时钟；没有认证SDK/真实钱包路径。SDK完成后主代理仍需执行完整包移位验证。

新产品的 `service-health`、`research-archive`、`research-archive-api`、`wallet-api` 和 `managed-runtime` 原测试 **31项通过**。这些覆盖会话令牌、Host/Origin、归档秘密与重解析点保护、模拟恢复意图、注入时钟与资源关闭。

日志：`standalone-base-tests.log`、`portable-server-regression.log`。现有全套974项属于此前生产版本回归，本文件不把它们冒充新独立/真实交易版本的全套验证。

## 主代理后续集成

- 给start接上默认liveFactory，真实交易默认关闭；SDK、签名桥和真实账户数据独立验证。
- 完成UI与SDK后显式调用 `writeReleaseSourceManifest`，再生成最终文件/运行时包清单；基础代理未生成最终清单，避免把并发编辑登记成最终发行版。
- 在不stub真实交易代码的完整发行包上，验证搬迁后启动、控制台、关闭及SDK依赖加载；不得为了验证而发真实交易。
- 便携版默认端口18790，当前机器QA使用配置端口或`portOverride`（主代理指定18890），防止接管原生产端口。

本轮只完成新账户基础，未迁移旧生产资金、历史账本或研究数据；原事故未知区间继续留在原生产证据中。
