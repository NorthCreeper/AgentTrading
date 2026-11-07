# Calendar threshold integration design review

Read-only review completed 2026-10-18 HKT. Production source reviewed: `ray-strategy.mjs`, `controller.mjs`, `ray-onetap-sizing.mjs`, `ray-dynamic-twap.mjs`, `ray-entry-panel.mjs`, `ray-runtime-check.mjs`, existing tests, and the frozen previous dynamic study. No production files were modified by this review.

## Decision

Calendar classification can be integrated immediately as causal, auditable metadata. A distinct active numeric threshold requires category-specific evidence. Categories with no admissible evidence inherit the registered 40/60/80 USD HKT session baseline and must say `inherited-baseline / insufficient-independent-date-evidence`. Merely assigning each category a different number would manufacture validation.

The existing dynamic study has 8,187 sampling-complete rounds but only 383 complete rounds with genuine opening and contemporaneous clock witnesses, mainly 17–18 October; only 317 also have qualifying causal volatility. Its profitable funded candidates have at most 6 independent executed rounds. Weekend selection can describe this sample; it cannot separate a weekend effect from this one market episode. Most older full-depth books cannot supply the missing contemporaneously known true opening. They remain useful for calendar liquidity, spread, depth, gap and return-volatility descriptions, which are different evidence from admission-rule after-cost returns.

## Production seams

1. Add a pure `dashboard/ray-calendar.mjs`. Export `classifyRayCalendar({ now, calendar })`, `selectRayThreshold({ now, session, baseThresholdUsd, calendar, artifact })`, a calendar schema version and a frozen policy version. `evaluateRay()` calls the selector after validating current time/market/TWAP/opening and before the deviation comparison. Selection must use only the supplied verified `now`, with no network or `Date.now()` inside the function.
2. Store the compact result on **both** the overall decision and selected candidate, e.g. `calendarThreshold: { policyVersion, calendarVersion, calendarSha256, artifactId, artifactSha256, asOf, decisionAt, nyDate, utcDate, hktDate, session, tags, primaryTag, baseThresholdUsd, effectiveThresholdUsd, status, reason, evidence }`. Existing `autoRayEntry()` clones the candidate into each entry lot, so candidate provenance is necessary; top-level-only metadata would disappear from durable lot evidence. Persist relevant event IDs/windows and source record IDs, rather than dumping an annual calendar into each frame.
3. Use one output `thresholdUsd` in the selected candidate and the actual deviation test. Do not leave the candidate reporting base while comparing a special threshold. Extend `scoreType`/reason to identify the active choice. `controller.evaluate()` must use `decision.thresholdUsd`, rather than `rayProtocol.thresholds[session]`, as the basis of any dynamic shadow if that shadow is explicitly intended to include the calendar base. Otherwise label the shadow baseline separately so comparisons are unambiguous.
4. Existing `beforeSubmit()` already re-evaluates the strategy at execution. Retain that fresh threshold/calendar check. Crossing an event/session/date boundary between signal and submission may invalidate a request. Record signal classification and final acceptance/rejection evidence; do not silently pretend the submitted intent used a later classification. Existing amount, price, size, equity, cash, FAK and exposure checks remain operative.
5. Surface effective threshold, classification, dates/timezone, evidence status and fallback in `ray-entry-panel.mjs`. A policy with all categories inheriting baseline should explicitly show that the categories were identified but no separate numeric threshold has been admitted.

## Time and membership contract

- Use `Intl.DateTimeFormat` with explicit `America/New_York`, `Asia/Hong_Kong` and UTC. Preserve current HKT session boundaries (06:00/12:00/22:00); the baseline night session spans midnight but a US event date does not follow the HKT date. Do not express New York as a constant UTC−4 or UTC−5 offset.
- Store verified scheduled event instants as UTC epochs plus source local date, local time and named timezone. Convert offline during calendar build, then round-trip validate. Avoid parsing locale-dependent date strings at decision time.
- `weekend` must specify a convention. Prefer `ny-weekend` for the US-market context and also retain `utc-weekend`/dates for cryptocurrency analysis. NY Friday night can already be Saturday HKT; US Sunday evening can coincide with futures reopening. A 24-hour weekend tag does not itself encode US futures availability.
- Distinguish `nyse-full-closure`, `nyse-early-close`, `us-federal-holiday`, `us-bond-holiday` and `ordinary-weekday`. In particular, federal holidays such as Columbus Day are not automatically NYSE closures. Holidays observed on a different day must use official observed closure dates, not only nominal calendar dates.
- CPI, jobs, FOMC and verified crypto expiries are precise event windows, not arbitrary all-day risk classifications. Keep the source date label separately. FOMC statement and press conference are separate events; never infer a time from a guessed recurring pattern. A publication revision/cancellation must preserve its prior snapshot and known time.
- Use half-open membership `[startAt, endAt)`. Classify at decision time (and again at submit), rather than hard-assigning an entire five-minute round from its opening. This allows a last-120-second entry window to cross an event boundary correctly. Record all overlapping tags; `primaryTag` is an attribution convention, not proof that other events have no effect.

## Overlap and fallback

- Declare overlap precedence in the frozen policy (for example scheduled release window, exchange closure, partial exchange session, NY weekend, ordinary). This display precedence must not accidentally become an economic optimization.
- A numeric artifact must declare whether it covers that exact category intersection. Do not multiply independent weekend/holiday/event factors or take an unvalidated maximum/minimum. If no exact admitted rule or preregistered pooling rule exists, use the declared baseline fallback and record all tags.
- Calendar manifest contains `schema`, `version`, `generatedAt`, explicit timezone definitions, sources/content digests, per-source coverage intervals and published/known times, and the event list. Coverage is source-specific: having the NYSE annual calendar does not establish CPI/FOMC coverage. A weekend can still be known when scheduled-event coverage is unknown.
- Malformed, expired, incomplete, unavailable or after-decision-known schedules return a structured status such as `calendar-unavailable`, `coverage-expired`, `event-time-unknown` or `source-not-yet-known`. They must not silently be treated as an ordinary weekday. Since current active strategy does not depend on a special date rule, preserve its registered baseline as explicit fallback; do not introduce a new trading halt as a hypothetical precaution. If a future adopted artifact requires complete calendar coverage, its failure policy must be separately registered.
- Artifact availability and calendar event membership are separate. A past training cutoff does not make an artifact available in a historical replay: `artifactCreatedAt`/`admittedAt` must also precede the decision for a prospective simulation. A model fitted today to the older dates is retrospective research only.

## Evidence and parameter contract

An admitted numeric artifact should carry exact immutable raw source-prefix hashes, coverage/unknown exclusions, true-opening/clock predicates, training and untouched test date sets, candidate grid declared before outcome inspection, selection metric, after-fee FAK/account/settlement replay version, delay/depth sensitivity and per-category sample counts. Store both independent round count and independent **date/event instance** count. Hundreds of five-minute rounds within one Saturday are not hundreds of weekend replications. Require date-blocked chronological evaluation and preferably rolling forward folds; one-sided labels or zero signals remain explicit. Do not tune dozens of event/window/session interactions on six profitable trades.

Use partial pooling/shrinkage toward the baseline rather than independent parameters for every sparsely observed named holiday, if and only if that pooling procedure is itself fixed and verified. Holiday names should first be grouped by predeclared economically meaningful market state, with residual individual-date facts descriptive. A calendar-specific gate and the strength-to-allocation map are different artifacts: admitting one must not automatically enable 10% allocation. Current unvalidated strength remains 2.5%.

Spread/depth/volatility diagnostics over the older full-book population may motivate a future candidate, but cannot be relabeled validated original-strategy profit. Missing openings, clocks, fees, official outcome availability, data gaps and no legal min-size order are not negative returns, ordinary rejections or zero opportunity. All-history inventory and fixed cutoff should be refreshed for appended logs without scanning derived/replayed copies as independent sources.

## Versioning and owners

- Preserve v3 executed owners, lots, round fill ledger and original exit revision. A display/shadow-only classification can retain the execution protocol with a new independently hashed calendar observation policy. If actual threshold behavior changes, create a new strategy protocol/profile, explicit alignment marker and new experiment. Never append new-policy entry lots to a retained older-policy owner. The current `autoRayEntry()` experiment/protocol guard already blocks this pattern.
- Current restoration and ledger validation explicitly recognize only v2/v3 in several controller predicates. A v4 must be added without weakening old v2 integer sizing or v3 FAK checks. `ray-runtime-check.mjs` currently hardcodes v3; register the intended version and add policy/threshold provenance checks. New source/calendar/artifact files must be in the source closure or immutable manifest registered alongside it, including JSON assets that the existing `*.mjs|html|css` source collector would otherwise miss.
- Preserve old registrations, source snapshots, legacy failures and experiments. Do not regenerate their hashes to make old audits green. Build a new immutable registration and link its parent. Back up and verify cash, fees, order reports, active owners, pending settlement, session and controls before one planned reload. No funds/reset or fabricated fills. Profile policy digest must change if an actually used calendar source/threshold artifact is updated.
- Classification should be available in frame/decision/opportunity exports and persisted order/lot reasons. Entry-owner top-level decision remains the first entry, so category performance must use per-lot classifications and aggregate the round as the independent execution unit, not classify all later lots by the first lot alone.

## Test matrix

| Area | Required examples and assertions |
|---|---|
| HKT sessions | 05:59:59.999/06:00, 11:59:59.999/12:00, 21:59:59.999/22:00; night across HKT midnight; exact unchanged 40/60/80 fallback |
| NY boundaries | Friday→Saturday, Sunday→Monday; opposite HKT date; midnight boundary within a round; UTC/NY weekend tags intentionally differ |
| DST | Spring jump and fall repeated hour for America/New_York; 08:30/14:00 local release epochs on each side; no hand-coded constant offset; event instants remain unique |
| Holiday semantics | Actual NYSE full closure, observed holiday, early close before/at/after close, federal-only holiday with NYSE open; no nonexistent full-closure label |
| Event membership | 1 ms before start, exact start, 1 ms before end, exact end; separate statement/press events; unknown precise time yields descriptive date only |
| Overlap | Weekend+holiday, macro+crypto expiry, multiple releases, closure+event; full tag set retained; deterministic primary; no unregistered factor stacking |
| Calendar faults | Missing manifest, malformed JSON/schema, digest mismatch, duplicate IDs, negative/inverted interval, unsafe label display, unknown zone, future knowledge, expired source coverage and schedule cancellation/revision |
| Model faults | Missing artifact, unadmitted artifact, train cutoff after decision, artifact created after decision, source hash mismatch, unsupported intersection/session, insufficient independent event dates; explicit baseline and reason |
| Causality | Modifying future frames/outcomes/schedule revisions must not change past decisions; full-day realized volatility never enters same-day gate; frame.now/knownAt and runtime clock retained |
| Decision fidelity | Numerical comparison uses effective threshold; direction stays signed; candidate, selected decision and lot threshold/provenance agree; above/exact/below boundary reject/accept behavior |
| Submission races | Signal before event/threshold boundary and submit after it; re-evaluation rejects invalid request; no second submit/overspend; final accepted policy metadata persisted |
| Owners | Restart v2/v3 unchanged; retained old owner is managed to official settlement; new profile cannot add lots to old owner; same-version calendar categories on separate lots aggregate without quota reset |
| Risk invariants | Amount FAK/fee rounding/min request/2.5%–10% authorized range, unvalidated 2.5%, $25 acquisition-cost exposure, max 100 actual shares, unknown equity/expired cash, no live execution |
| Runtime audit | Calendar/policy/JSON manifest tamper becomes degraded; new version can coexist with retained v2/v3 evidence; old register/failure/source byte hashes remain unchanged; audit never claims whole-history profitability |
| Replay | Raw-prefix inventory unchanged, no duplicate derived sources, all exclusion populations counted, date-block independent statistics, execution delay 0/1/2 s separated, finite cash and official settlement wait |
| UI/story | Calendar status→API decision→persisted lot→display match; correct threshold and timezone; unknown is visible; no false specialized-threshold or validated-strength label; baseline controls remain usable |

## Highest priority checks before any activation

1. Never label an all-history weekday/weekend volatility study a validated true-opening strategy replay.
2. Never call a federal holiday an NYSE closure or use a fixed New York UTC offset.
3. Never store category provenance only at top-level; current durable lot path clones the candidate.
4. Never let changed active threshold rules share the old protocol/profile/cohort or append to an old owner.
5. Never omit calendar JSON from the registered dependency closure, and never bless old audit hashes after modifying their sources.

