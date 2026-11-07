# K/E first-exit model: synthetic implementation only

2026-10-08. This NEW D package implements the numerical/model portion of the already frozen `conditional-terminal-exit-design-20261007` K/E design. It does not modify the source-v2 collector, original main/held files, data gates, entry/exit rules or any account. No original raw file, actual strict target, fitted probability, actual date output or new cash result was opened in developing/running this package. Tests use only invented January 2020 dates and handwritten synthetic rows.

The model estimates the strict official terminal payout **of the direction already held** at the original first confirmed exit intent. K uses held midpoint logit as an offset, with ridge-calibrated intercept/standardized midpoint logit/log remaining seconds. E adds exactly the standardized signed liquidation-haircut residual `extra`. Both fit on the identical complete nominal feature/strict target mask. Acquisition cost is sunk for the conditional hold-versus-sell comparison and is not a predictor. It must be restored, together with buy fees, in the later full-account ledger. A terminal payout probability is not net EV, a profit guarantee or account deployment permission.

Input adapter, to be owned and authenticated upstream, must preserve the entire nominal `precheck.row` and add only four fields:

```javascript
{ ...precheck.row,
  sourceVersion: 'conditional-first-exit-causal-prefix-source-v2',
  day: hongKongDay(Number(precheck.row.slug.split('-').at(-1))*1000),
  originalPrecheckRowDigest: precheck.rowDigest,
  target: {status:'known', payoutUp:0 /* or 1 */, knownAt, proofDigest}
}
```

The original digest is independently recomputed after removing those four adapter fields, and predictions return the original digest. The old row's `targetRead:false` describes source enumeration at that time. Model reports explicitly say `targetsRead:true`: fitting and diagnostics inspect the supplied synthetic/strict target values. Target status/digest format checks in this package do not authenticate official archives or original source bytes. Only the future upstream strict label adapter can do that. `payoutUp` is converted by held `outcome` before fitting; Down forecasts must not use an Up payout directly.

Pressure runs must keep the nominal fee regime for `extra`, midpoint, normalization and model probability. `currentExecutableNetSale` with fee × 1.5 is a separate cash/action hurdle. Do not train on pressure-distorted features or inject pressure fields into the original precheck row.

`fitConditionalTerminal(rows,{sourceDateSplit,actualBuiltAt})` takes a separately frozen source-only calendar, containing `supportedEndedDates`, `cutoff`, `frozenAt`, `trainDates` (first 7), `validationDates` (next 3), `scoreDates` (all remaining, minimum 3). It cannot truncate score dates or reuse prior study dates. Known training labels must be before validation start minus 60 s. Automatic and manual-one-tap have independent models/qualification; no cross-origin fallback is available.

Root clarified qualification before any actual data inspection: each origin needs at least 300 unique official trigger rounds/7 train dates, official terminal Up and Down each at least 30 unique rounds, and held payout 0 and 1 each at least 30 unique rounds. Counts of held buying Up/Down are reported only. The supplied `originalRoundCount` and 1/N `originalRoundWeight` are retained from the entire round/origin riskset before all feature/label/delay masks; they are never recomputed to increase retained mass.

Every stratum fits a point K/E pair plus the full fixed-seed 128 train-date block resamples. Every draw re-estimates its own three-coordinate weighted mean/scale and both heads; zero variance uses the original deterministic unit-scale convention. Ridge is 20, maximum 100 Newton iterations, declared gradient maximum 1e-8, prediction clip 1e-6. The compensated local Armijo solver uses the proper binary loss and strict residual checks. A failed draw is retained as unavailable and invalidates prediction, including point-only use; old T/C/M or any point fallback is prohibited.

`predictConditionalTerminal(artifact,row,{mode})` returns B0 and `models.K/E` with `pointHeldProbability`, the complete ordered `heldProbabilityDraws`, lower sensitivity, original `rowDigest`, origin/outcome and support flags. Shared support is the original |z| ≤ 6 domain across the three coordinates. `future-causal` additionally requires the model to have been born by the row time. The held sensitivity is `min(point, floor-index 2.5% draw quantile)`; it represents fitted parameter sensitivity, not the probability of guaranteed payout.

`conditionalTerminalDiagnostics(rows,artifact,{period,targetKnowledgeCutoff})` reports each origin and all registered validation or score dates, rejected/unknown/not-yet-known rows, B0/K/E weighted CE/Brier, each leave-one-date-out aggregate and calibration differences. Validation E requires lower overall CE/Brier than K, at least 2/3 lower daily CE, and lower CE in every LODO. Zero/missing supported days fail the diagnostic gate. Every score date is still reported after a failed gate. Target knowledge cutoff must be the actual independently captured target observation bound, not supplied future knowledge. This diagnostic gate does not authorize account replay or adoption.

Remaining root work: authenticate full causal riskset/source calendar; freeze strict official target adapter and unknown bounds; independently audit this package; use same first entry/original full execution/partial fills/1 s and 2 s delays and verified cash/settlement timing for the five-arm thirty-account comparison. All original absolute net-positive, fee stress, unknown inventory, minimum trade/date, relative full-account/date-block and concentration/family gates remain. Fewer losses or better synthetic fitting is insufficient.
