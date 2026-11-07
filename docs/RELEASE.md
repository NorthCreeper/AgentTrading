# 源码与发行包

本目录依据 v1.0.6 Windows x64 便携包的文件清单整理。源码、固定资源、依赖锁文件和第三方许可保留原始字节，源码清单登记的 209 个文件已逐项校验。

- 完整 ZIP 提供可运行的 Windows 应用。解压后双击 [Start.cmd](../Start.cmd)。便携包包含 Windows Node.js、后台启动程序、依赖和初始配置。
- 本目录提供源码审阅和维护材料，保留已校验的 Windows 后台启动辅助程序及其 [C# 源码](../service/headless-host.cs)。[依赖锁文件](../app/package-lock.json) 记录 SDK 版本，[启动入口](../app/start.mjs) 负责装载应用和核对发行资源。实际运行仍需完整发行目录中的 Node.js 和依赖。
- 开发环境可从[初始配置模板](../config/app.example.json)和[空档案目录模板](../archives/catalog.example.json)开始。运行时由本机管理 `config/app.json` 和 `archives/catalog.json`。
- 完整便携包中的 `package-manifest.json` 登记所有发行文件。本目录保留[源码清单](../resources/release-source-manifest.json)，其核对范围为源码与固定资源。
- 项目档案、运行数据、凭据及备份留在本地。源码路径中的固定研究资源随源码保留。第三方许可原文见[许可目录](../licenses/)。

原始 v1.0.6 便携包 SHA-256 为 `d5280da369bc38090367016288cb2eaaf75d5d871927c00100419d74285fd19d`。

对外发行附件 `BTC5M-Standalone-v1.0.6-utf8.zip` 以 UTF-8 存储文件名。包内内容与原版逐文件一致，ZIP 的 SHA-256 为 `f30e272a42b4aa34a6dc84de501812954db8b900bf6e261efe71a6b52ab0f868`。
