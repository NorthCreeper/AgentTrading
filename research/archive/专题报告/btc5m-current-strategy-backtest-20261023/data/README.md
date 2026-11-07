# Unified full-history inputs for current-strategy replay

Quote/report freeze: **2026-10-23 19:37:34.859 HKT**, API time `1792755454859`. Every quote, report and original byte range is bounded by this fixed freeze; the production runtime continued appending normally.

Use these final inputs:

- `execution-frames.jsonl.gz`: 5,846 sorted eligible rounds, 756,859 full-depth captures; last 135 seconds per round. It contains standard concatenated gzip members. Its first 413,260,747 compressed bytes are exactly the previously verified 5,706-round execution dataset, followed by 140 new eligible rounds and 17,050 captures. The original inherited gzip digest was independently rechecked during verification.
- `canonical-series.jsonl.gz`: 8,475 sorted report groups and 2,496,255 reports, with original E18/recorded precision, actual receipt/primary-known clocks and source witnesses. The report group universe includes excluded rounds; select eligible rounds via the descriptors.
- `round-descriptors.json`: all 11,019 recorded rounds and explicit qualification/exclusion reasons.
- `eligible-descriptors.json`: the 5,846 qualifying descriptors.
- `official-labels.json`: verified official payout evidence, identity, opening/final cross-checks and original observation times. Outcomes are not causal entry features.
- `source-manifest.json`: inherited 42-source prefix paths/hashes, separate hashed incremental ranges, output hashes and scope.

The former 5,706 eligible rounds are unchanged. The incremental review covered 226 round captures, admitting 140 and preserving 86 exclusions. Reasons overlap: 53 have incomplete 60-second TWAP paths, 43 incomplete frame paths, and the currently unfinished round also lacks final outcome evidence. The complete frozen raw and TWAP paths are observational completeness; they do not certify continuously fresh, two-sided executable books or actual fills. All original book source timestamp semantics remain unverified.

Only two original sources grew: the current session's frame and price files. Incremental scanning also recovered the 159 frames and 176 prices that were already inside the old registered byte prefixes but were correctly excluded at the former cutoff. Old original 13.9GB frame history was not rescanned. Global original line numbers for incremental witnesses were derived from bounded tail newline counts and the prior source line totals; byte witnesses remain the primary exact references.

One fully recorded round, `btc-updown-5m-1792755000` (19:30–19:35 HKT), lacked a saved outcome at the quote freeze. Read-only Gamma and CLOB verification subsequently agreed with the recorded exact-start/end TWAP. Its label is explicitly marked `postFreezeOutcomeVerification: true`, with **observedAt `1792756047421`** and unchanged quote cutoff. A continuous account may credit this payout only after that observedAt. This observation must never be backdated into entry information.

`inventory/unified-data-verification.json` independently streams both final gzip files, checks sorted scope and all 5,846 rounds, verifies the inherited gzip prefix byte-for-byte, confirms output digests, and compares 13 bounded original byte witnesses. It reports no differences. `inventory/post-freeze-outcome-verifications.json` preserves the extra official evidence and bounded depth recovery. `inventory/incremental-exclusions.final.json` is the final exclusion list.

Files named `*-v2`, `*.pre-finalization*`, and the 139-round `incremental-round-index.json` belong to the initial incremental build before the separately marked post-freeze outcome and global-line finalization. They are retained as intermediate evidence. Use the final names above for replay.

No production source, account control, historical ledger or original raw data was changed or deleted.
