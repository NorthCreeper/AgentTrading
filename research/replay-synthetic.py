"""Recalculate the deliberately synthetic BTC5M example without network access."""

import csv
import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Result:
    status: str
    reason: str
    side: str = ""
    cost_cents: int = 0
    payout_cents: int | None = None

    @property
    def net_cents(self) -> int | None:
        if self.payout_cents is None:
            return None
        return self.payout_cents - self.cost_cents


def replay(row: dict[str, str]) -> Result:
    if row["feed_status"] != "fresh":
        return Result("unobserved", row["feed_status"])
    if any(not row[field] for field in ("twap_delta_usd", "up_ask_cents", "down_ask_cents")):
        return Result("unobserved", "missing_values")
    if not 0 < int(row["seconds_left"]) <= 120:
        return Result("rejected", "outside_window")

    delta = int(row["twap_delta_usd"])
    if abs(delta) < int(row["threshold_usd"]):
        return Result("rejected", "threshold_not_met")

    side = "UP" if delta > 0 else "DOWN"
    up_ask = int(row["up_ask_cents"])
    down_ask = int(row["down_ask_cents"])
    ask, opposite = (up_ask, down_ask) if side == "UP" else (down_ask, up_ask)
    if not 80 <= ask <= 85:
        return Result("rejected", "price_out_of_range")
    if opposite > 20:
        return Result("rejected", "opposite_ask_too_high")

    shares = int(row["filled_shares"])
    fee = int(row["fee_cents"])
    if shares < 0 or fee < 0 or (shares == 0 and fee != 0):
        raise ValueError("Invalid synthetic fill")
    if shares == 0:
        return Result("no_fill", "eligible_without_fill", side)

    cost = ask * shares + fee
    winner = row["winner"]
    if not winner:
        return Result("awaiting_resolution", "winner_unknown", side, cost)
    if winner not in {"UP", "DOWN"}:
        raise ValueError("Invalid synthetic outcome")
    payout = 100 * shares if winner == side else 0
    return Result("settled", "winner_provided", side, cost, payout)


def main() -> None:
    dataset = Path(__file__).resolve().parent / "data" / "synthetic-rounds.csv"
    results = []
    print("case   status                side    net cents  reason")
    with dataset.open(encoding="utf-8", newline="") as handle:
        for row in csv.DictReader(handle):
            result = replay(row)
            results.append(result)
            net = "" if result.net_cents is None else str(result.net_cents)
            print(f'{row["case_id"]:<7}{result.status:<22}{result.side:<8}{net:>9}  {result.reason}')

    counts = Counter(result.status for result in results)
    closed = [result for result in results if result.payout_cents is not None]
    summary = {
        "rounds": len(results),
        "status_counts": dict(sorted(counts.items())),
        "eligible": len(closed) + counts["no_fill"] + counts["awaiting_resolution"],
        "profitable": sum(result.net_cents > 0 for result in closed),
        "settled_cost_cents": sum(result.cost_cents for result in closed),
        "settled_payout_cents": sum(result.payout_cents for result in closed),
        "settled_net_cents": sum(result.net_cents for result in closed),
        "pending_cost_cents": sum(result.cost_cents for result in results if result.status == "awaiting_resolution"),
    }
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
