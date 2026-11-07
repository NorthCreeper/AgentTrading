# Windows 独立版依赖审计

范围：只读检查应用源码、静态导入、静态 JSON 与服务配置，未扫描多 GB 原始行情，不改生产、不启停任务、不连接钱包。本审计针对新增真实交易模块之前的应用快照；真实交易模块引入依赖后需要重新做构建清单。

机器清单：dependency-audit.json（原件见项目档案），复查脚本：dependency-audit.mjs。

## 结论

当前后台已脱离聊天进程，但尚不能复制文件夹后直接换机器使用。主要障碍是跨目录的研究代码、跨 D 盘的资源/写入路径、含绝对路径的源码登记及Windows任务安装配置。现有生产后台 healthy，PID 17744、守护重启0，本次审计无需停机。

应用顶层和 dashboard 共124个非测试 mjs/html/css，server + app 静态/字面量动态导入闭包114个源码，缺失导入0。闭包没有npm第三方裸包；依赖均为Node内置模块或本地相对模块。两个浏览器模块路径 /amount-order.mjs 和 /one-tap-order.mjs 由 server 映射到 lab 上层对应文件，不是缺失文件。

现有固定运行时为Windows x64 Node v24.19.0，92,825,416字节；SHA256 `3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237`。实测内置 fetch、WebSocket、structuredClone 均存在。便携版应随包携带此固定运行时，避免依赖PATH、Codex缓存或安装npm。当前运行时目录只有node.exe，做正式分发包时应补齐与该Node版本对应的发行说明和许可证文件。

## 需要随应用保留的代码和静态资源

1. lab顶层和 dashboard 所有非测试 mjs/html/css（体积很小，保留全部比手工裁剪更可靠）。不要将 dashboard 单独扁平复制；相对 import 和代码自校验依赖原结构。
2. 下列6个研究代码文件确实被生产模块静态导入，即使Ray模式冻结旧研究仍不可省：

   - research/history-optimization-20261002/replay.mjs
   - research/history-optimization-20261002/suite.mjs
   - research/history-optimization-20261002/history-catalog.mjs
   - research/history-optimization-20261002/portfolio.mjs
   - research/history-optimization-20261002/execution-policies.mjs
   - research/history-optimization-20261002/entry-policies.mjs

3. `research/p3-adaptive-account-20261001/pre-registration.json` 是 adaptive-account.mjs 顶层无条件读取的协议文件，缺失会阻止 server 静态导入。
4. dashboard/reports 共29个JSON、合计5,649,149字节。建议整体随包，避免UI静态下载和旧研究显示丢失。Ray主策略直接需要 `ray-calendar-data.json`、`ray-calendar-policy.json`，两者哈希绑定；缺失会降级回原时段门槛。其余有6个UI下载路由以及旧模型/结算种子读取，不能仅凭主策略暂不用便声称全部可删。
5. terminal-admission-artifact.json 固定哈希 `fe5865209d2f25b06fd9a15c27f6a7a99acac232ca351087fcda69303fd821f2`，是现有stage3影子研究的外部资源，应打包到应用自有资源目录；不改变模型、不重新拟合。

## 路径改造清单

| 当前路径来源 | 现有入口 | 独立版处理 |
|---|---|---|
| server.mjs:24 terminal artifact | 无env，仅factory参数 | 配置为应用根内资源文件，保持固定模型哈希 |
| server.mjs:26 live-shadow输出 | 无env，仅factory参数 | 改为data/observations，独立实例/新队列不能混写生产队列 |
| server.mjs:27 archive catalog | 无env，仅factory参数 | 相对应用根配置；目录内部归档路径同样须可搬迁 |
| research-archive.mjs:33、51 | allowedRoots硬编码D:/Trade和D:/TradeResearch，服务/运行时保护目录也硬编码 | 显式传入应用根、历史卷根及受保护目录；继续阻止读取运行凭证/当前金融文件，不能为便携性放开整个磁盘 |
| server.mjs:28 Ray registration | BTC5M_RAY_ALIGNMENT_REGISTRATION | 支持包内相对路径登记；复制后验证所有源哈希。原生产登记只读保留，不能直接改写旧历史证据路径冒充原登记 |
| server.mjs:29 legacy independent pointer | BTC5M_INDEPENDENT_RESEARCH_MANIFEST | 没有随迁旧研究进程时明确未配置/已归档，不沿用旧PID和健康状态 |
| server.mjs:112 legacy audit status | lab/research/strategy-continuation-20261002/automatic-audit/status.json | 配套自有审计服务，或明确未配置；不能把复制来的过期成功当作本机当前审计 |
| server数据目录/端口/恢复意图 | BTC5M_DATA_DIRECTORY、BTC5M_DASHBOARD_PORT、BTC5M_RECOVER_INTENT | 已可配置，可统一由launcher按自身路径传递 |
| service-config.json | nodePath、serverPath、dataDirectory绝对路径，固定任务名/端口 | 相对目录解析；安装任务时生成本机路径；同机多份实例使用不同任务名和端口，或拒绝冲突 |
| service/control-backend.ps1 | 固定18790和已安装任务依赖 | 所有操作读取同一配置；portable未安装时也应能启动自己的隐藏守护/后台 |
| 打开BTC控制台.ps1 | 固定长目录树、必须有Windows任务、自动启动旧readonly审计 | 根目录launcher；不依赖旧任务名、旧研究目录或Codex |

现有 env 完整清单：BTC5M_DATA_DIRECTORY、BTC5M_DASHBOARD_PORT、BTC5M_RECOVER_INTENT、BTC5M_RAY_ALIGNMENT_REGISTRATION、BTC5M_INDEPENDENT_RESEARCH_MANIFEST。

## 最小可靠便携目录建议

```text
BTC5M/
  启动.cmd / 停止.cmd / 检查状态.cmd
  备份.cmd / 恢复.cmd / 使用说明.md
  runtime/node.exe
  app/btc5m-lab/<顶层源码>
  app/btc5m-lab/dashboard/<源码、HTML、CSS、reports>
  app/btc5m-lab/research/<上述6代码及协议JSON>
  config/app.json
  resources/terminal-admission-artifact.json
  evidence/registration.json
  service/<自有隐藏host、守护及安装/卸载脚本>
  data/runtime/<金融账本、checkpoint、结算档案>
  data/observations/<新实例的研究采集>
  archives/catalog.json / <可选历史卷>
  logs/ / backups/
  release-manifest.json
```

上述结构保留lab内相对位置，包外路径统一由app.json解析成应用自有目录。原机打包时使用白名单选取文件，不能递归复制整个research/runtime。source closure与reports的逐文件哈希见JSON。

## 新建与迁移必须分开

- **全新独立账户**：显式初始化当前Ray策略及风险规则，真实交易默认关闭；不能直接依赖空数据目录默认值。现有controller空目录 defaults仍含maxExposure=10、maxLoss=2以及旧strategyDefaults，这与当前运行策略不一致。初始模拟资金需要明确用户设置或复制经过说明的模拟资金配置，不能自动捏造成历史账户资金。
- **迁移现有账户**：要在停止/静止边界复制主状态、两代检查点、对应金融/成交日志、当前持仓和待结算队列、开仓去重/请求ID、官方结果归档、恢复基线/未知历史证据。直接复制正在写入的state.json不能构成一致备份。
- **历史资料**：完整历史大日志应作为可选数据卷/归档搬迁，清单里记录是否齐全。已有交易、研究状态不能为了减小便携包而在生产中删除。当前旧研究JSON约4MB至81MB不等，已冻结但仍可用于原研究显示；若不随迁，应明确属于“新实例不含旧研究”，不能复制历史累计收益却省掉其核对证据。
- **旧路径证据**：history-approval、evolution和恢复证据里存在绝对来源路径。它们是历史引用，不应字符串全局替换。需要随迁的文件保留原来源+新位置映射和哈希；缺失时显示不可读，不冒充已恢复。
- **并发**：已有port和runtime lease能防同一端口/数据目录的双写；独立版还需要实例身份，禁止启动第二份去接管原生产数据或旧Windows任务。

## 系统与网络依赖

现有守护使用Windows任务计划程序、Windows PowerShell、Windows Job Object隐藏host；host已预编译，重新编译脚本依赖系统.NET Framework csc。当前任务是用户登录范围，未登录时不会持续运行。便携版应明确普通双击后台与可选开机登录托管的区别；不能宣称无需Windows登录的系统服务。

行情仍需要互联网：Polymarket Gamma/CLOB HTTP、市场WS与RTDS；订单流用Binance/Coinbase公共WS及Binance深度HTTP；校时用Binance/Coinbase时间HTTP；钱包现金只读用固定Polygon RPC。独立于聊天应用不表示可以离线交易。网络/源时间失效时保留现有拒绝开仓和未知数据口径。

本审计未发现运行当前只读钱包/模拟版所需的npm包；用户随后要求开发的真实交易模块应在其完成后另列SDK、浏览器连接方式、版本锁和运行依赖，真实交易默认关闭。
