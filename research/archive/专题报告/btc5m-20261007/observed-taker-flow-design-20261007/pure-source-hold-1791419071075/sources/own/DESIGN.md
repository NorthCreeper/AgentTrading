# Observed taker flow: source readiness only

This NEW study remains separate from all held static/model/label studies. It reads no labels, model coefficients, predictions, accounts or cash. Source-only execution requires a NEW root registration and exact command-line registration SHA. The agent preparing this design does not run actual sources. Original held 20/22/50 and other source holds are unchanged.

The single hypothesis is that recently observed Binance BTCUSDT taker pressure could contain incremental information beyond the current Polymarket midpoint and recorded Chainlink TWAP. This is a hypothesis, not a profitability assertion. The only possible future F model adds one signed base-BTC volume fraction to C. Its later fixed paired B0/T/C/F evaluation must beat all three controls and satisfy executable after-cost whole-account and untouched future gates. There is no minimum87%, six-filter intersection or forced trading. This task stops at source availability.

## Source meaning and fixed window

[Binance's official aggregate-trade documentation](https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#aggregate-trade-streams) defines T as trade time, E as event time and m as whether the buyer is maker. Thus buyer-maker means taker sell; the opposite means taker buy. The local adapter already preserves those clocks, base-BTC quantity, aggregate-trade sequence and opposite taker side. Binance USDT quotes never replace USD prices or official TWAP.

The current source schema was reviewed directly in dashboard/p2-context.mjs, SHA bcaa9b2858d4e67df1f0c84d1f3ee26895a1f3b53e0a63c138842b8de8851c52. Its activityWindow includes whole intervals with activity.from >= selected context.time−30000 and context.time <= selected end. The first from must be at most2000ms later than that nominal boundary, each interval is complete and at most3000ms, and at least15 intervals exist. A first interval crossing the left boundary is omitted in full. No prorating, insertion, alignment or physical-arrival estimate is allowed. The 1007ms synthetic sampling case demonstrates this distinction. A temporary root concern about a time-based filter was checked against the exact source and withdrawn; no actual data was used to choose the definition.

Recompute (sum original takerBuyBtc−sum original takerSellBtc)/sum original quantityBtc. Verify the independent rounded original quantities conserve within the predeclared8-decimal tolerance. Zero observed quantity is unknown. Missing optional activityWindows[30] can be reconstructed from original intervals. A present summary must agree with the same fixed source definition; failure means not qualified for this definition, not proof that raw data is absent or that the entire original feed was bad.

These are locally observed receipt-time interval counts. They do not certify total exchange volume, full market flow, source-time30s volume, exact aligned30s trades or a tradable arbitrage. The trace retains original from/to, observed duration, decision lag, source/receipt clocks, segment/epoch/connection and quantities.

## Causal qualification

Use the same original-byte-order latest released whole same-session/slug context as v3, with frameAt strictly before the fixed original decision. Current/future frames are excluded; latest invalid/stale/missing source frame is not replaced by an older valid one. Same-time whole-bundle conflict and an older duplicated window time reject. Every interval requires its own original frame identity/witness, same segment/epoch/connection, exact adjacent from/to chain and first/last source/receipt constraints.

Original v3 context-clock whole-prefix qualification remains required. Reuse its unchanged native fixed-prefix reader and byte-order receipt highwater cursor. Keep original times unchanged and attach distinct conservative release bounds/cause witnesses. Every interval release must be <= selected recorded window end <= decision/cutoff. In particular, a lower original latest processing time than the highwater release makes this feature unknown; do not retime it. No source sorting or repaired timestamps occurs.

## Population and actual source entry point

Use exactly the independently audited original43 prefixes, same13,739,723,861 bytes, cutoff1791303594758 and manifest SHA8b971578d81a85fa3193bee42190e66982fb55ab81297a1c14ce125e50ce2865. The original complete gzip anchors preserve every29-slot canonical round. Decode every original anchor; do not choose a new session, replace first anchors or recalculate their existing source mask. Reopen actual original canonical frame and original context/frame interval witnesses. Preserve static1/N assigned before flow or target masks and all unknown slots. Full43 native/prefix hashes are checked before and after; immutable source outputs, own current/copy closure and original parent current/copy closure are checked before and after. No raw contexts/books are copied.

The runner writes derived complete per-slot gzip source records with compact original byte references and fixed member SHA/CRC/size/count certificates, then source-only daily/round/support/rejection counts. Physical output cap256MiB, disk reserve4GiB, decoded complete trace cap1GiB and line cap8MiB remain fixed. Failure artifacts and partial outputs are retained. Insufficient13 ended dates is an explicit source readiness failure; never lower it or infer dates from filenames/current API. Having13 nonempty ended source dates is only a necessary availability condition, not fitting authorization or adequate statistical sample size.

Root supplies native immutable pins for manifest, sourceReport, sourceMetadata, anchors, sourceIndependentProof and pureCodeProof in a NEW root registration. SourceReport/metadata/anchors must match the completed original independent proof's exact parent output SHA/bytes. The root registration schema is implemented by validateRootRegistration in runner.mjs, requires sameOriginal43Prefixes=true/newLengthsCaptured=false and all target/fit/cash/probability/order/runtime permissions=false. ownSourceClosureDigest equals the new pure proof's sourceClosureDigest. Root alone captures its exact process/log handle:

```
node runner.mjs run NEW_ROOT_REGISTRATION EXACT_ROOT_REGISTRATION_SHA256
```

This program does not create root authorization automatically. A later source extension including the ended Oct7 day requires a separate NEW complete source registration/audit; it must not overwrite or extend this original manifest.
