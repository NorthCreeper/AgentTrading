# Polymarket BTC 5m — Strategy & Trading Logic (Complete System Doc)

> **Mode: PAPER ONLY.** No private keys, no live CLOB orders.  
> Code root: `/workspace/polymarket-btc-5m/`  
> Live controls snapshot: **2026-10-14 23:43:15 HKT** via `GET http://127.0.0.1:8787/api/state`  
> Disclaimer: observation / paper simulation only — **not a proven edge; no profit guarantee.**

---

## 1. Market

| Item | Value (from code) |
|------|-------------------|
| Series | BTC Up/Down 5-minute windows |
| Slug pattern | `btc-updown-5m-{unix_start}` where `unix_start = floor(now/300)*300` |
| Window length | **300 s** (`discovery.WINDOW_SEC`) |
| Outcomes | `Up` / `Down` |
| Discovery | Gamma API `https://gamma-api.polymarket.com/events?slug=…` (`paper_bot/discovery.py`) |
| Settlement oracle | Chainlink BTC/USD **TWAP 60s** (Gamma `resolutionSource` / streams) |
| Local TWAP source | Public Polymarket RTDS `wss://ws-live-data.polymarket.com` topic `crypto_prices_twap_sixty` (`twap_feed.py`) |
| Open reference | Same RTDS topic `crypto_prices_chainlink` nearest `window_start` (±2.5s; fallback tolerance **300s**) |
| Collateral | pUSD; redeem winner → $1 / share, loser → $0 |
| Min order / tick | **5 shares** / **0.01** (from market meta; paper respects depth clamp) |
| Fee schedule label | **`crypto_fees_v2`** (taker-only) |

**PolyBolt** (`wss://ws-live-v2.polymarket.com/ws`) is **not used** — requires CLOB API keys (`polybolt_status=auth_required_not_used`).

---

## 2. Modes

| Mode | Status |
|------|--------|
| **PAPER** | **Only mode implemented for trading.** Dashboard `controls.mode = "PAPER"`. |
| Live / signed orders | Out of scope — stack never loads keys or posts orders. |

Paper account persists to:

- `/workspace/polymarket-btc-5m/logs/paper_account.json`
- `/workspace/polymarket-btc-5m/logs/paper_ledger.jsonl`
- `/workspace/polymarket-btc-5m/logs/paper_ledger.csv`

---

## 3. Strategies available & selection

Dashboard / CLI `--strategy` pattern: `^(random50|late|cs_arb|both|ray)$`.

| Strategy key | Module | Role | Default in dashboard |
|--------------|--------|------|----------------------|
| **`ray`** | `signal_ray.py` + `ray_filters.py` + `twap_bands.py` | Combined late TWAP-band + book asym + Ray filters | **Yes** (`DashboardEngine.strategy = "ray"`) |
| **`cs_arb`** | `signal.py` | Complete-set: buy both asks when `net_edge > min_edge` | CLI default historically; dashboard prefers ray |
| **`late`** | `signal_late_directional.py` | Late-window favorite (≥`late_min_price`) or cheap mode | Off unless selected |
| **`random50`** | `signal_random50.py` | Per-window fair coin flip + buy side if ask ≤ `r50_max_ask` | Off unless selected |
| **`both`** | — | Runs cs_arb + late (+ r50 if configured); not ray | Off |

**How selected**

1. Dashboard UI / `POST /api/controls` with `strategy`.
2. CLI `python -m paper_bot --strategy …`.
3. Engine branches in `main.snapshot_once` / `dashboard.poll_once`:
   - `run_cs = strat in ("cs_arb","both")`
   - `run_late = strat in ("late","both")`
   - `run_ray = strat == "ray"`
   - `run_r50 = strat in ("random50","both") or (strat=="ray" and ray_include_random50)`

**Ray + random50:** `ray_include_random50` default **`false`** (live controls confirm).

---

## 4. Fee model — `crypto_fees_v2`

From `paper_bot/fees.py` (aligned with `fee_check.py` / ARCHITECTURE.md):

\[
\mathrm{fee} = C \times \mathrm{rate} \times p \times (1-p)^{\mathrm{exponent}}
\]

| Param | Default |
|-------|---------|
| `rate` | **0.07** |
| `exponent` | **1** |
| Maker | 0 |
| Applies | **Taker only** |
| Rebate | ~20% fee-pool to makers — **not** counted in paper PnL |

Helpers: `fee_per_share`, `fee_for_size`, `complete_set_fees`, `net_edge = 1 - ask_sum - fees_per_pair`.

Live `/api/state`: `fee_rate=0.07`, `fee_exponent=1`, market `fee_type=crypto_fees_v2`.

---

## 5. Strategy: `cs_arb` (complete set)

**File:** `paper_bot/signal.py`

- Inputs: best ask Up/Down + ask sizes.
- `net_edge = 1 - (ask_up+ask_down) - fee_up - fee_down` (per share-pair).
- **Actionable** when `net_edge > min_edge` **and** both ask sizes ≥ `size`.
- Defaults (live): `min_edge=0.005`, `size=5.0` (cs size; separate from late/ray max size).
- Paper broker FOK-at-touch both legs; abort one-leg tracked as `aborted_one_leg`.

Honest note: near 50/50, dual taker fees alone ≈ 3.5¢/pair — need `ask_sum` meaningfully below 1.

---

## 6. Strategy: `late` (late directional)

**File:** `paper_bot/signal_late_directional.py`

| Param | Default |
|-------|---------|
| `late_sec` | **90.0** |
| `late_min_price` (favorite) | **0.90** |
| `late_mode` | **`favorite`** |
| `max_cheap` (cheap mode) | **0.10** |
| Fee skip zone | **[0.40, 0.60]** |
| `late_max_size` / `DEFAULT_MAX_SIZE` | **25.0** |
| Hard size cap without allow_large | **100.0** |

Logic (favorite): `secs_to_end ≤ late_sec`, buy side with ask ≥ `min_price`, skip mid fee-danger band, clamp size to ask depth.

Confidence ladder: `book_only` → `book_plus_spot` (Coinbase) → `book_plus_twap` → `twap_aligned` (TWAP vs open agrees).

**Ruin note:** wrong-side ~99¢ favorite ≈ total stake loss.

---

## 7. Strategy: `random50`

**File:** `paper_bot/signal_random50.py`

| Param | Default |
|-------|---------|
| `r50_max_ask` / `DEFAULT_MAX_ASK` | **0.49** |
| Seed | **42** |
| Size | uses control `size` (live **5.0**) |

Per window: deterministic coin flip → side; buy only if that side’s ask ≤ max_ask. **Not a proven edge** (explicit `edge_note` in state).

---

## 8. Strategy: `ray` — full pipeline (current live)

**Files:** `signal_ray.py`, `ray_filters.py`, `twap_bands.py`  
**Adapter:** `RaySignal.as_late_signal()` → `paper_broker.try_ray_directional`.

### 8.1 Parameter defaults (code + live controls)

| Param | Code constant | Live `/api/state` |
|-------|---------------|-------------------|
| `ray_late_sec` | `RAY_LATE_SEC = 120.0` | **120.0** |
| `ray_min_price` | `RAY_MIN_PRICE = 0.55` | **0.55** |
| `ray_max_price` | `RAY_MAX_PRICE = 0.85` | **0.85** |
| Hard skip ask | `RAY_HARD_SKIP_ASK = 0.90` | (fixed in evaluate) |
| `ray_book_asym` | `RAY_BOOK_ASYM = "80/20"` | **80/20** |
| `morning_usd` | `DEFAULT_MORNING_USD = 40.0` | **40.0** |
| `midday_usd` | `DEFAULT_MIDDAY_USD = 60.0` | **60.0** |
| `night_usd` | `DEFAULT_NIGHT_USD = 80.0` | **80.0** |
| Max size | `DEFAULT_MAX_SIZE = 25.0` via `late_max_size` | **25.0** |
| `ray_include_random50` | False | **false** |
| `auto_trade` | True (dashboard) | **true** |
| `paper_exit` | False | **false** |
| `poll_sec` | 5.0 | **5.0** |

Session hours (Asia/Hong_Kong) in `twap_bands.py`:

| Session | Hours HK | Threshold | Display band |
|---------|----------|-----------|--------------|
| morning | 06–12 | `morning_usd` (40) | 40–50 |
| midday | 12–22 | `midday_usd` (60) | 60 |
| night | 22–06 | `night_usd` (80) | 80–100 |

Gate: `|TWAP − open| >= threshold_usd` (`twap_deviation_ok`).

### 8.2 Evaluation order (`evaluate_ray`)

1. **Book errors / missing asks** → `book_error…` / `empty_or_missing_ask`
2. **Late gate:** `seconds_to_end ≤ ray_late_sec` (120) else `not_late secs=…>120.0`
3. **Open known:** require `twap_hint.open_known` and `vs_open` else `twap_open_unknown`
4. **TWAP deviation:** `|vs_open| >= session threshold` else `twap_dev_below thr=…`
5. **Side:** trade `vs_open_side` (`Up`/`Down`); flat/unknown → `twap_flat_or_unknown`
6. **Hard skip ≥90¢:** `ask >= 0.90` → `hard_skip_ask …` / filter `chase_ge_90`
7. **Price band:** ask in **[0.55, 0.85]** else `price_out_of_band`
8. **Book asymmetry:** own ask ≥ `asym_hi` (0.80) **and** other ask ≤ `asym_lo` (0.20) for `80/20`; else `book_not_asym`
9. **Ray filters** (`RayFilters.check_entry`) — see §8.3
10. **Depth:** size = `min(want, ask_size, max_size)`; if sized &lt; 1 → `insufficient_depth`
11. **Actionable:** `reason=actionable_ray_twap_band`, confidence preferably `twap_aligned`

### 8.3 Ray filters (cheap ≤10¢ / chase ≥90¢)

**File:** `ray_filters.py`

| Rule | Constants | Behavior |
|------|-----------|----------|
| Never chase ≥90¢ | `CHASE_FLOOR=0.90`, `hard_skip_chase=True` | `ray_skip_chase` / `chase_ge_90` |
| Cheap ceiling | `CHEAP_CEIL=0.10` | Applies only when entry ask ≤ 10¢ |
| Late-first cheap | `DEFAULT_LATE_FIRST_HIT_SEC=60` | Skip if cheap first appeared only in last 60s of window |
| Stale cheap | `DEFAULT_STALE_CHEAP_SEC=120` | Skip if ask stayed ≤10¢ for &gt;2 minutes |

Note: Ray’s primary band is 0.55–0.85, so cheap≤10¢ filters rarely fire on the main path; hard skip ≥90¢ is the dominant chase protection (also duplicated before filters).

### 8.4 Paper fill path

- Broker reason strings like `fok_ray_ray_twap_band_Up` / `_Down` (ledger).
- Size clamp: `min(late_max_size, ask_size, remaining max_shares_per_window)`; hard cap without `allow_large`.
- Observed: 19× size **25**, 1× size **15** (depth clamp).

---

## 9. Paper account & settlement

**File:** `paper_bot/paper_account.py`

| Item | Default / behavior |
|------|-------------------|
| Starting cash | **1000.0** pUSD |
| Auto buy | When `auto_trade=True` and strategy fill `status=="filled"` → `book_buy_from_fill` |
| Cost | Includes crypto_fees_v2 (`fill.cost`) |
| Settle | `settle_except_window(current, outcome_side=prior_twap_vs_open_side, reason="window_roll")` on each poll when window rolls |
| Exit reason observed | All 20 closed trades: **`window_roll`** |
| Intra-window exit | `paper_exit.py` — **off by default**; TP mid +0.05 / stop mid −0.08 if enabled |
| Marks | Mid of bid/ask while open |

Win/loss: exit_price 1.0 → won; 0.0 → lost (redeem vs TWAP-aligned outcome side used as settlement proxy).

---

## 10. Data feeds

### 10.1 CLOB books

| Path | Detail |
|------|--------|
| WS | `wss://ws-subscriptions-clob.polymarket.com/ws/market` (`ws_market.py`) |
| REST fallback | `https://clob.polymarket.com/book?token_id=…` |
| Stale book | `STALE_AFTER_SEC = 15.0` → REST if WS tick age too old |
| UI/API | `data_source`: `ws` \| `rest` \| `stale` \| `error` |

### 10.2 RTDS TWAP / spot

| Path | Detail |
|------|--------|
| URL | `wss://ws-live-data.polymarket.com` |
| TWAP topic | `crypto_prices_twap_sixty` symbol `btc/usd` |
| Spot/open | `crypto_prices_chainlink` |
| **Zombie / stale reconnect** | `STALE_RECONNECT_SEC = 45.0` — if no crypto_prices_* update for 45s, force reconnect (PING/PONG alone can keep a dead socket) |
| **Open fallback** | `OPEN_FALLBACK_TOLERANCE_SEC = 300.0` — after mid-window reconnect, allow open ref within full 5m window (prior ~30s left Ray stuck on `twap_open_unknown`) |
| Open match (tight) | `OPEN_MATCH_TOLERANCE_SEC = 2.5` |

### 10.3 Known ops issues fixed

1. **Zombie TWAP socket** — WS “connected” but `crypto_prices_*` stalled; fixed by 45s stale reconnect (`twap_feed.py`; bak `twap_feed.py.bak_20261011`).
2. **`twap_open_unknown` after reconnect** — open capture window widened to **300s** so Ray can still resolve open mid-window.

Stdout evidence (current `dashboard_stdout.log`): **43** `stale_twap … reconnecting` lines; **15** WS disconnects; **8** “1013 slow consumer” events.

---

## 11. Controls & API / dashboard

**Process:** `dashboard.py` → `http://127.0.0.1:8787/`

| Endpoint | Role |
|----------|------|
| `GET /api/state` | Full snapshot: controls, books, twap, paper, portfolio, history |
| `POST /api/controls` | Update running, strategy, sizes, auto_trade, paper_exit, etc. |
| `POST /api/poll-now` | Force one poll |
| `GET /api/health` | Liveness |

**Live controls snapshot (2026-10-14 23:43:15 HKT):**

```
running=true  strategy=ray  mode=PAPER  auto_trade=true  paper_exit=false
poll_sec=5  poll_count≈2005  started_at=2026-10-14 18:05:52 HKT
min_edge=0.005  size=5  late_sec=90  late_min_price=0.9  late_max_size=25  late_mode=favorite
r50_max_ask=0.49  ray_late_sec=120  ray_min_price=0.55  ray_max_price=0.85
ray_book_asym=80/20  ray_include_random50=false
morning_usd=40  midday_usd=60  night_usd=80
fee_rate=0.07  fee_exponent=1
paper_cash=1000 (starting; equity now 1053.419475)
```

UI: static dashboard under `/` + `static/`; shows LIVE WS/REST, TWAP vs open, session band, Ray reason, portfolio.

History deque: `HISTORY_MAX=180` points of `{ts, ask_sum, net_edge, slug, source}` — **does not persist vs_open or skip reasons to disk**.

---

## 12. Logging / what is (not) persisted

| Artifact | Contents |
|----------|----------|
| `paper_ledger.jsonl` | account_init, set_starting_cash, **buy**, **exit** — **no** `vs_open` |
| `paper_account.json` | cash, closed[], open — **no** `vs_open` |
| `paper_YYYYMMDD_HHMMSS.jsonl` | Early CLI `RunLogger` snapshots (Oct 10–11); not continuous for Oct 12–14 fills |
| `dashboard_stdout.log` | Uvicorn access + TWAP stale/WS errors; **not** per-poll Ray reasons |
| Live `/api/state` | Current `ray_vs_open`, `ray_reason`, `ray_trade_reason` only for **now** |

Implication for replay: closed trades can be fully rebuilt for PnL/equity; **exact TWAP deviation at entry must be marked UNKNOWN** unless future logging adds it.

---

## 13. End-to-end Ray poll (mental model)

```
discover slug btc-updown-5m-{T}
  → WS/REST books Up/Down
  → TWAP feed snapshot (twap, open, vs_open, vs_open_side)
  → settle prior window positions (window_roll, outcome≈prior vs_open_side)
  → evaluate_ray (late → open → |vs_open| → side → hard skip → band → asym → filters → depth)
  → if actionable & auto_trade: paper buy (FOK size clamp)
  → optional paper_exit (off)
  → mark-to-mid; expose /api/state
```

---

## 14. Related docs & analysis outputs

- `ARCHITECTURE.md` — market/fees research snapshot  
- `LIVE_DATA.md` — feed verification  
- `logs/analysis/TRADE_TWAP_AND_SKIPS.csv` — per-trade enrichment  
- `logs/analysis/SKIP_REASON_SUMMARY.md` — skip aggregates  
- `logs/analysis/FULL_REPLAY_ANALYSIS.md` — Chinese+numbers replay  
- `logs/analysis/ray_sizing_comparison.csv` — sizing counterfactuals  
- `logs/analysis/ray_retrospective.md` — prior verified stats  

---

*Generated from live code + `/api/state` for Ray. Paper-only. Do not treat historical WR as future expectancy.*
