#!/usr/bin/env python3
"""scan_pro: the desk scans the whole market, not just the book.

Three quality screens over TradingView's scanner (same source and screen
concepts as mphinance/momentum-mcp's screener; conditions composed in a
single where() because chained wheres overwrite in tradingview-screener v3).
Liquidity floors keep OTC junk out: NASDAQ/NYSE/AMEX, price > $5,
volume > 2M, cap > $2B. Descriptive output only: what screened, never picks.

Writes scan.json (both copies). Runs with signals in the same workflow.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from tradingview_screener import Query, col

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIRS = [os.path.join(HERE, "..", "data"), os.path.join(HERE, "..", "docs", "data")]

COLS = ["name", "description", "close", "change", "volume", "relative_volume_10d_calc", "RSI", "market_cap_basic"]
FLOORS = [
    col("exchange").isin(["NASDAQ", "NYSE", "AMEX"]),
    col("close") > 5,
    col("volume") > 2_000_000,
    col("market_cap_basic") > 2_000_000_000,
]

SCANS = [
    {
        "id": "momentum",
        "title": "Momentum leaders",
        "note": "Price above a rising EMA structure, RSI 55-75, sorted by day move",
        "conds": [col("EMA20") > col("EMA50"), col("close") > col("EMA20"), col("RSI") > 55, col("RSI") < 75],
        "sort": "change",
    },
    {
        "id": "volume",
        "title": "Unusual volume",
        "note": "Trading at 3x-plus their normal volume today",
        "conds": [col("relative_volume_10d_calc") > 3],
        "sort": "relative_volume_10d_calc",
    },
    {
        "id": "oversold",
        "title": "Oversold quality",
        "note": "Large caps with RSI under 32, on the mat, not a signal to buy",
        "conds": [col("RSI") < 32],
        "sort": "market_cap_basic",
    },
]


def cap_txt(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    if v >= 1e12:
        return f"{v / 1e12:.2f}T"
    if v >= 1e9:
        return f"{v / 1e9:.1f}B"
    return f"{v / 1e6:.0f}M"


def run_scan(scan):
    q = (
        Query()
        .select(*COLS)
        .where(*FLOORS, *scan["conds"])
        .order_by(scan["sort"], ascending=False)
        .limit(10)
    )
    total, df = q.get_scanner_data()
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "ticker": r.get("name"),
            "company": (str(r.get("description") or "")[:48]) or None,
            "price": round(float(r.get("close") or 0), 2),
            "changePct": round(float(r.get("change") or 0), 2),
            "relVol": round(float(r.get("relative_volume_10d_calc") or 0), 1),
            "rsi": round(float(r.get("RSI") or 0), 1),
            "cap": cap_txt(r.get("market_cap_basic")),
        })
    return {"id": scan["id"], "title": scan["title"], "note": scan["note"], "totalMatches": int(total), "rows": rows}


def write_both(name, obj):
    body = json.dumps(obj, indent=2, default=str) + "\n"
    for d in DATA_DIRS:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, name), "w") as f:
            f.write(body)


def main():
    out = []
    for scan in SCANS:
        try:
            out.append(run_scan(scan))
        except Exception as e:  # noqa: BLE001
            out.append({"id": scan["id"], "title": scan["title"], "error": str(e)[:100], "rows": []})
    ok = sum(1 for s in out if s.get("rows"))
    write_both("scan.json", {
        "updated": datetime.now(timezone.utc).isoformat(),
        "universe": "NASDAQ/NYSE/AMEX, price > $5, volume > 2M, cap > $2B",
        "scans": out,
    })
    print(f"scan_pro: {ok}/{len(SCANS)} scans returned rows")
    if ok == 0:
        raise SystemExit("all scans empty, treat as failure")


if __name__ == "__main__":
    main()
