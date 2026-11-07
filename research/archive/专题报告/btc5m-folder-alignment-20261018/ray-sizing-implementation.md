# Ray 纯策略仓位对齐结果

2026-10-18。只修改纯策略、纯数量计算及对应测试；未启动服务、未修改账户、未访问行情。

## 变更

- `dashboard/ray-strategy.mjs`：策略版本改为 `ray-twap-band-equity-v2`；协议单次及每窗份额上限 100，预算比例 0.025，最低份额 5。`exitRevision` 保持 `ray-official-settlement-v1`。
- 新增 `dashboard/ray-sizing.mjs`：每笔 `floor(equity * .025 / feeInclusiveCostPerShare)`，再按卖一深度、`config.size`、100 份硬顶和本轮剩余额度裁剪，最后再次 floor。与参考 Python 最终整数算法一致。不得为了最少 5 份向上抬高预算。
- `evaluateRay` 新增参数 `equity`、`roundUsedShares=0`。缺失或无效净值返回 `equity_unknown`；预算、深度或配置数量不足返回 `size_below_min`；本轮剩余额度不足最低份额返回 `round_share_cap`。
- 结果的 `sizing` 和候选的 `sizing` 均保留预算、含费单价、原始份额、深度、单次上限、每窗已用及剩余量、最终份额和裁剪原因。
- 原开盘参考身份/±2.5 秒、TWAP 5 秒、盘口新鲜度、metadata、tick、方向与价格规则全部保留。调用方仍负责整体 $25 风险门槛与可信净值来源。
- 没有净值的旧回放调用会明确返回 `equity_unknown`，不会回退固定份额；本任务没有重跑或修改旧回放结果。

## 只读参考对照与测试

1. `node --test dashboard/ray-sizing.test.mjs`：**5 通过，0 失败，0 跳过**。
2. 该测试通过 Python `-I -B` 只导入用户目录中的纯 `paper_bot.sizing.compute_equity_size`，不启动交易入口；**98 组边界用例**的预算、原始份额、最终份额、可下单标志和含费单价全部匹配。覆盖 80/81/84/85¢、零净值、当前约 $103 净值、5 份门槛两侧、5/15.99/100 份深度、大净值及配置裁剪。
3. `ray-strategy.test.mjs` 的纯策略/开盘/持久开盘恢复选择测试：**4 通过，0 失败**。控制器集成 fixture 与断言交由控制器负责人调整，未宣称其在本子任务单独全部通过。
4. 额外明确检查：100 份每窗上限只剩 4 或 4.9 份时拒绝；正好剩 5 份可以使用；无效已用份额拒绝。没有“凑够 5 份”的预算扩张。

## 修改前备份

原始字节备份在 `before-source/dashboard/`，不覆盖已有备份。清单 `reference-strategy-before-manifest.json`：

- `ray-strategy.mjs`：SHA256 `693A9C198CDBB4A0CD810702CF3F7392D5A1792E4974DC267964A8A5A1996197`，4998 字节。
- `ray-strategy.test.mjs`：SHA256 `9BCDD859E434D884759664080B8EE70EA10E278C43C5FE71569CC745492E68A2`，8952 字节。

本子任务完成时纯策略源码 SHA256：

- `ray-strategy.mjs`：`1C811A86DE60F21D1E63BB7E5895A1D35BBA63B59B453B80D90BCE18B09E0C56`
- `ray-sizing.mjs`：`C26CC85670C82014E1AC119CA562C3C4E7477A9306296B46F9FFFD23D6537D61`
- `ray-sizing.test.mjs`：`FD65FCB69977604783C05769ADACA27EE7F991C4ED8EC8F3763A32BA37D4DE77`

路径均相对当前 lab：`归档目录/Trade\CloddsBot-review\CloddsBot-715fd4a6c06b4cd5bb38eee225dd09b3bc95c5e8\btc5m-lab`。
