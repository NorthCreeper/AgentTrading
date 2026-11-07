# 回放执行 helper

`replay-buy.mjs` 只负责 One-Tap 请求和逐档 FAK 成交估算。主事件引擎仍须完成源时钟、新鲜度、完整性、正确开盘、快速事件边沿、已消费轮标记、即时净值、现金和待执行信号串行排队。

```js
const p = prepareReplayBuy({book, market, equity, cash, kind:'base', roundUsedShares, now:signalAt});
if (p.ok) {
  const request = {...p.request, signalAt, earliestExecutionAt:signalAt+1000};
  // caller chooses a genuinely new eligible execution book at / after latency
  const r = executeReplayBuy({request, book:executionBook, market, consumed, now:executeAt});
  consumed = r.consumed;
  // r.ok describes replay observability; count a fill only when r.filled > 0.
  // cash -= r.total; keep every positive partial, and kill unfilled remainder.
}
```

`kind:'rapid'` 去掉 80–96 美分绝对价带与每单/轮 100 份上限；保持净值 2.5% 含费预算、现金充足、市场最低请求、2 美分滑点保护以及合法 tick。`kind:'base'` 完整比例请求超过 100 份或当前 `100-roundUsedShares` 时否决，不将预算偷偷缩小。

请求保存固定 `size`, `amountUsd`, `maxSpend`, `price`, `marketIdentity`, `marketFee`；执行阶段不按后来的卖一改请求。`now` 是可选检查输入，不填则 helper 不推断执行时间。它不以自己的 wall clock 读历史。

`executeReplayBuy` 的 `ok:true` 包括零成交取消；正成交订单只看 `filled>0`。`ok:false` 是无法有效回放或请求不合格，调用方应依 `reasonCode` 分类。未知资料不得伪装成真实成交失败。

`consumed` 形如 `{snapshots:{'tokenId|timestamp':{fingerprint,asksUsed:{'0':usedShares}}}}`，按原快照档位索引记录。源时间相同但接收时间变了不会补回流动性；同源身份卖盘内容冲突返回 unknown。输入对象不变，调用方传递返回对象。同一源时间的不同 token 独立。新源时间快照可使用新显示深度；这仍是历史盘口估算，并非完整反事实市场冲击模型。

11 项测试含恰好 2000 组随机深度，逐笔本金/手续费/数量/终态与保留的生产 `PaperBroker` 完全一致。`method-freeze.json` 固定 helper、测试、日志和被只读引用的生产源码 hash；`production-source/` 保存源码副本以便将来复核。主分析运行前后应检查源 hash 未漂移。
