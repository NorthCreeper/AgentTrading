# Storage and research recovery review

Read-only audit of existing storage paths, followed by the parent-authorized settlement-shadow change below. Review performed 2026-11-05 Asia/Hong_Kong. No service start/stop or account changes performed by this subtask.

## Findings

1. `Controller.savedState`, `initialize` and `snapshot` persisted `recoveryHold`, but did not persist the detailed `recoveryEvidence` added to the recovered candidate. After the first successful initialize/save, the recovery source hashes, unknown-tail scope and stale nonfinancial fields no longer appeared in the primary snapshot. The external candidate/proofs retained them. Preserve a validated recovery lineage field even after the temporary hold is cleared.
2. `writeJsonAtomic` now flushes a completed temporary file before rename. There was no rotating, checksummed, independently named previous generation. A failed rename leaves its temporary candidate, but a successful replacement does not retain the prior good primary. That is insufficient as the only recovery source after primary corruption. A minimum improvement is a separately named, bounded checkpoint generation with digest and sequence, retained before financial cutover and on financial changes; never silently initialize an empty financial account when the primary is invalid.
3. Main event JSONL writes and trade JSONL writes used synchronous append without flush. Durably flush financial/control events and completed-trade records, while retaining explicit crash-tail unknown semantics. Startup should preserve any non-newline suffix and insert a boundary before appending new records, rather than joining a new JSON object onto a corrupted suffix. Missing final bytes still cannot be inferred from the later line.
4. Legacy research continued doing work and durable whole-file writes under the replacement Ray strategy. `acceptFrame` always invoked settlement-shadow sampling and `observeStrategies`; P1, P3 and P3Confirmation saved on each frame even with entry permission false. `observeValue` still drove value/adaptive research, whose restored states were about 61 MB and 82 MB. This competes with source/clock callbacks, particularly after flush was enabled. It is a plausible load contributor, not a proven cause of the historical clock outages.
5. AdmissionValidation can recompute labeled-arm totals, completed cache and paired comparisons from protocol-matching outcome records. It cannot faithfully reconstruct all raw observation counters, pending-market identity and coverage gaps from its sparse observation logs alone. `admission-validation-observation` is throttled and does not include the whole market; active rounds may require raw frames. TerminalAdmissionShadow outcome records can restore outcome-derived statistics, but frame/prediction/reset counters and its recent reference points need their corresponding records. Mark unrecovered counters/rounds unknown, or start a clearly registered new observation cohort; do not fill them with zero and call the result continuous history.
6. OrderflowRecorder explicitly promises write completion only, not fsync. It uses concatenated gzip members, so interrupted final members must retain partial/unknown status and recording run/sequence boundaries. An accepted row is not a durable row, and `written` is not proof it survived power loss.

## Authorized change implemented by this subtask

Only `settlement-shadow.mjs` and the new `settlement-shadow-archived.test.mjs` were edited. `acceptFrame` accepts a sixth options argument with `researchEnabled=true` by default. When false, it:

- registers and saves a newly encountered market once;
- reconciles only still-pending pre-existing shadow entries against the original verified strict labels and availability time;
- saves only when one of those operations changed state;
- creates no new shadow entry, observation sample or decision;
- leaves `acceptResolution`, official financial labels and conflict detection unchanged.

The parent owns the Controller call-site and Ray-mode legacy-observer guards.

## Validation

The focused command ran `settlement-shadow-archived.test.mjs`, `settlement-shadow-financial.test.mjs`, and `settlement.test.mjs`: 22 tests passed, zero failures. The two new tests cover 50 unchanged frames without additional writes, new-round persistence, no sample journal or shadow entry creation, crash recovery between strict evidence archival and ledger save, future-availability rejection, and restart/idempotent payout.

## Minimum additional checks for the parent

- Recovery lineage survives save, failed mutation, hold clearing and restart without being silently omitted.
- Checkpoint selection rejects a corrupted checksum, an incompatible session, or a future/unverified generation; selecting an older valid checkpoint preserves an explicit reconciliation boundary.
- A financial flush failure does not publish a replacement account or clear a halt; a partial JSONL suffix remains preserved and the next record has independent framing.
- Ray-mode source processing does not call old P1/P3/value/adaptive samplers, but current financial settlement and owned position management still work.
- Research restoration compares the reconstituted labeled totals against append-only source events; any nonrecoverable counter and pending round is explicitly reported.

These changes improve recovery and load handling. They cannot retroactively recover the 421 unknown bytes or certify the crash-time financial state.
