# BTC console archive dependency review

Read-only review, 2026-10-19 HKT. No production API commands, restarts, file relocation, deletion or compression were performed. `dependency-inventory.json` records current path/metadata and source-code digests; `collect-dependencies.mjs` only reads production files and writes this independent evidence directory.

## Authoritative strategy boundary

The main-strategy replacement event is **1792174174840**, **2026-10-17 02:09:34.840 HKT**, `main_strategy_replaced`, protocol `ray-twap-band-v1`, preserved in `归档目录/TradeResearch/ray-replacement-20261017/replaced-before-start.json` and `ray-started.json`. The first Ray experiment (`归档标识-007`) started at **1792174175048**, 208 ms later. The earlier `request-registration.json.cutoff=1792173401200` is a historical-input cutoff, not the deployed strategy boundary.

Use this event boundary to label pre-Ray evidence. Keep later Ray v1/v2/v3/v4/v5 cohorts separately. The current session `归档标识-008` contains both pre-Ray and subsequent Ray history: a filename or session ID alone cannot split its rows into those eras. Do not truncate, split, relocate or recompress its still-growing logs as an old whole-session archive.

## Old research is still doing work

The current controller initializes old research classes unconditionally before loading the main strategy. Most constructors read both a `.json` state and a `.jsonl` journal to recover written IDs, sometimes flushing pending events. Removing those files can silently create a fresh study or break recovery.

| Module | Current Ray behavior | Required existing files |
|---|---|---|
| P1, P3 bid exit, P3 confirmation | `observe()` is still called every frame with `allowEntry=false`; they update history/lastAt, manage any retained research positions and write state. Disabling entry is not stopping computation. | `p1-study.json{,l}`, `p3-study.json{,l}`, `p3-confirmation.json{,l}` |
| StrategyObservation | Called every frame with no new Ray entries; retained observations may complete. It reads the journal and state at startup. | `strategy-observation.json{,l}` |
| SettlementValueResearch | Still computes old value forecasts, saves forecast/label events and consumes old fixed artifacts. | `p3-value-research.json{,l}`, reports `p3-value-model.json`, `p3-value-calibration.json` |
| AdaptiveResearch | Still receives new value samples/official labels and may perform causal model updates. | `p3-adaptive.json{,l}` and its pinned implementation dependencies |
| ContinuationStudy | Still advances retained forks; captures only `strategyTrade` (manual/legacy owner), not Ray's multi-owner array. Constructor recovers IDs from its full journal. | `continuation-study.json{,l}` |
| AdaptiveAccountStudy | Ray explicitly suppresses observe/new entries; constructor still loads/validates the old state/journal and the archived API rereads its state. | `p3-adaptive-account.json{,l}` |
| EvolutionCoordinator | Ray explicitly disables the coordinator, preserving original state; no current Ray adoption. | Main `state.json.evolution`, `evolution-maintenance.json`, `history-approval.json` remain retained recovery/governance evidence |
| P2Context | Still records causal multi-venue observations and source failures; Ray entry/close records link P2 context IDs. This is current market evidence, not merely obsolete model output. | Current session `-p2-feed.jsonl`, `-p2-context.jsonl`; source streams and current logs |
| SettlementShadow | Still computes `settlementFeatures/settlementDecision`, writes samples/state, and controller's allowShadowEntry currently is `auto&&!paused`, without a Ray-model predicate. Its old hypothetical ledger may still enter if its candidate qualifies. The same object also supplies current verified financial labels. | `settlement-shadow.json`, `settlement-samples.jsonl`, `outcomes/`, `financial-outcomes/`, reports settlement models/input/research |

If the product intent is to freeze old model computation, hiding cards is insufficient. Freeze obsolete forecasts/learning/ledger-entry branches explicitly while retaining financial-result validation, market registration, old orders/owners and current source capture. Do not disable SettlementShadow as a whole: current Ray official payouts depend on its `financialLabels` and archived dual-API evidence. Manual One-Tap exits use the current holdings/book/history/price logic; optional research capture is separate from their actual exit lifecycle.

## Hot, warm and cold rules

**Exclude from archive mutation:** current `state.json`; every file beginning with the active session ID; current `-trades`, `-frames`, `-prices`, `-decisions`, `-holding-decisions`, `-p0-*`, `-p2-*`; pending state/atomic temp files; all actively updated research state/journals above; `outcomes/` and `financial-outcomes/`; `归档目录/Trade/service/` config/status/locks/stdout/stderr/intent and supervisor scripts; current installed Node; live source assets and active audit/observer status/lock/WAL directories. Small stale server PID/output files are not enough evidence that the independent supervisor is inactive.

**Warm retained dependencies:** even currently unchanged `p3-adaptive-account`, observation/continuation states and journals must remain at their original paths until loaders are changed and tested. Frozen source snapshots, registrations, prefix manifests, plans, accepted evidence and failed observations are also reachable dependencies, not disposable copies. Keep these original bytes/paths. Transparent compression could be considered later, but moving them into a ZIP is not transparent.

**Cold candidates:** complete closed-session UUID logs other than the active session; dated `state-before*`/`state.before*` backups; fixed old experiment exports; completed research result/log/source snapshots not targeted by any active worker. Before acting require a stable file identity/size/mtime across observations, no active writer/worker, exact intended resolved path, and byte/prefix verification. Metadata time is only a candidate filter: verify actual row times before calling a file wholly pre-Ray. Preserve all current source/prefix hashes and unknown/failure evidence. `dependency-inventory.json.coldCandidates` provides the concrete metadata candidates without asserting they have already passed these final checks.

## Why original paths matter

- `归档目录/Trade/service/service-config.json` pins the actual main server and runtime paths. The backend cannot simply use an archive's replacement directory.
- The current v5 `ray-audit/registration.json` contains absolute `sourceFiles[].path`; its 365 preserved historical entries and 57 versioned plans retain exact paths and digests. Old v4/v3/v2 registrations and frozen source snapshots must remain resolvable. A UI change needs a new immutable source registration revision; do not edit old pins to force a pass.
- The frozen automatic companion uses an absolute runtime journal, current `/api/p3-continuation`, `outcomes`, original source hashes and its fixed prefix archive. Its existing source-mismatch failure is retained; moving the original journal or sources creates an additional failure rather than repairing it.
- `归档目录/TradeResearch/btc5m-repair-20261015/observers/active-registration.json` points at a hash-pinned registration and three 18791/18792/18793 directories, locks, status, proof and stop files. Health validates command-line paths and registration hashes. Exclude these live worker directories and their WAL/archive/manifest dependencies unless a separate explicit worker-retirement change is implemented.

## NTFS compression

D: was read-only verified as **NTFS / Healthy**. Standard NTFS compression retains the existing filename and presents logical file bytes transparently to applications, so it is the practical way to reduce cold storage without changing these absolute-path dependencies. This is supported by [Microsoft's file compression documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/file-compression-and-decompression) and the [compact command documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/compact).

This does not prove that every file is safe to compress while active. Select explicit cold files, retain identity/logical byte count/mtime/content hashes before and after, record allocated size separately, and verify readers/source pins still pass. Do not mark the whole live runtime directory for inherited compression. Do not use executable/WOF `/EXE` mode for trading data. ZIP/gzip substitution, relocation, renaming or deletion would require reader changes and do not meet the original-path contract. Already compressed archives offer little benefit and can be skipped. Storage compression does not itself remove old per-frame calculations or constructor parsing cost.

## Archive-center API requirements

Existing read APIs expose `/api/strategy-observation`, `/api/p1-study`, `/api/p3-study`, `/api/p3-confirmation`, `/api/p3-value`, `/api/p3-continuation`, `/api/p3-adaptive`, `/api/p3-adaptive-account`, `/api/strategy-evolution`, `/api/strategy-trades` and fixed static reports. The large value/adaptive states currently return tens of megabytes at once. These routes are useful for retained compatibility but should not all be eagerly loaded into the current Ray console or its snapshot/event stream.

Provide an independent manifest-backed archive center: summary/groups/storage totals/cutoff; bounded filtered file listing; bounded text preview; and streamed byte-preserving download by opaque manifest ID. The manifest is an allowlist, not a browser for arbitrary absolute paths. Resolve canonical paths inside explicitly allowed roots; reject traversal, symlinks/reparse points, secret names and live-runtime files. Expose logical bytes, allocated before/after, compression status, historical hash provenance, current existence/size/mtime warnings and the actual scope of verification. Never label unverified archives as currently verified or mix their historical profits with current Ray results. Binary files may download without text preview. Keep backend endpoints read-only and avoid giant JSON parsing or full multi-GB rehash on every request.
