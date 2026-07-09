#!/usr/bin/env python3
"""backtest_pro: the Proving Ground. Every strategy tested in the open.

Runs mphinance/momentum-mcp's real backtest engine (walk-forward simulation
with slippage) over his 6 strategy presets x every name in Quinn's book,
2 years of history each. Writes backtests.json with per-strategy aggregates
and per-name results, including buy-and-hold comparison, because most
strategies lose to just holding and the desk says so out loud.

Runs with the engine workflow. No keys (yfinance).
"""

from __future__ import annotations

import asyncio
import json
import os
import statistics
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))

from mcp_server.backtest import backtest_strategy  # noqa: E402

DATA_DIRS = [os.path.join(HERE, "..", "data"), os.path.join(HERE, "..", "docs", "data")]
PRESETS = [
    "ema_crossover",
    "rsi_bounce",
    "macd_momentum",
    "bollinger_squeeze",
    "golden_cross",
    "ema_stack_breakout",
]
PERIOD = "2y"


def read_json(name, fallback):
    for d in DATA_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            try:
                with open(p) as f:
                    return json.load(f)
            except Exception:
                pass
    return fallback


def write_both(name, obj):
    body = json.dumps(obj, indent=2, default=str) + "\n"
    for d in DATA_DIRS:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "w") as f:
            f.write(body)


def num(v, nd=1):
    try:
        return round(float(v), nd)
    except (TypeError, ValueError):
        return None


async def run():
    book = read_json("book.json", {"positions": []})
    tickers = sorted({str(p["t"]).upper() for p in book.get("positions", []) if p.get("t")})
    if not tickers:
        raise SystemExit("no book tickers")

    strategies = []
    for preset in PRESETS:
        rows = []
        desc = ""
        for t in tickers:
            try:
                d = await backtest_strategy(t, strategy_name=preset, period=PERIOD)
                if not isinstance(d, dict) or d.get("total_return_pct") is None:
                    continue
                desc = d.get("description") or desc
                rows.append({
                    "ticker": t,
                    "strategyPct": num(d.get("total_return_pct")),
                    "buyHoldPct": num(d.get("buy_and_hold_pct")),
                    "winRatePct": num(d.get("win_rate_pct")),
                    "trades": d.get("total_trades"),
                    "maxDrawdownPct": num(d.get("max_drawdown_pct")),
                    "profitFactor": num(d.get("profit_factor"), 2),
                })
            except Exception:  # noqa: BLE001
                continue

        tested = [r for r in rows if r["strategyPct"] is not None and r["buyHoldPct"] is not None]
        if not tested:
            strategies.append({"id": preset, "description": desc, "rows": [], "agg": None})
            continue
        beat = [r for r in tested if r["strategyPct"] > r["buyHoldPct"]]
        agg = {
            "names": len(tested),
            "medianStrategyPct": num(statistics.median(r["strategyPct"] for r in tested)),
            "medianBuyHoldPct": num(statistics.median(r["buyHoldPct"] for r in tested)),
            "beatBuyHold": len(beat),
            "avgWinRatePct": num(statistics.mean(r["winRatePct"] for r in tested if r["winRatePct"] is not None)),
            "avgTrades": num(statistics.mean(r["trades"] for r in tested if r["trades"] is not None), 1),
        }
        best = max(tested, key=lambda r: r["strategyPct"])
        worst = min(tested, key=lambda r: r["strategyPct"])
        strategies.append({
            "id": preset,
            "description": desc,
            "agg": agg,
            "best": {"ticker": best["ticker"], "strategyPct": best["strategyPct"], "buyHoldPct": best["buyHoldPct"]},
            "worst": {"ticker": worst["ticker"], "strategyPct": worst["strategyPct"], "buyHoldPct": worst["buyHoldPct"]},
            "rows": tested,
        })
        print(f"backtest_pro: {preset} done, {len(tested)} names, beat buy-hold {len(beat)}/{len(tested)}")

    write_both("backtests.json", {
        "updated": datetime.now(timezone.utc).isoformat(),
        "period": PERIOD,
        "universe": f"{len(tickers)} book names",
        "engine": "mphinance/momentum-mcp backtest_strategy, walk-forward with 10bps slippage",
        "strategies": strategies,
    })
    ran = sum(1 for s in strategies if s.get("agg"))
    print(f"backtest_pro: {ran}/{len(PRESETS)} strategies complete over {len(tickers)} names")
    if ran == 0:
        raise SystemExit("no strategies completed")


if __name__ == "__main__":
    asyncio.run(run())
