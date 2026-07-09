#!/usr/bin/env python3
"""signals_pro: real technical signals per book + watchlist name.

Runs mphinance/momentum-mcp's actual analyze_technicals engine (vendored in
agents/vendor/mcp_server, used with permission) on every book and watchlist
ticker, then distills the full institutional indicator suite (RSI, MACD, the
8/21/34/55/89 EMA stack, SMA 50/100/200, ADX + DI, ATR, Bollinger, plus his
plain-English writeup) into signals.json for the desk to render.

Runs on GitHub Actions with Python 3.12. No API keys (yfinance).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))

from mcp_server.technicals import analyze_technicals  # noqa: E402

DATA_DIRS = [os.path.join(HERE, "..", "data"), os.path.join(HERE, "..", "docs", "data")]


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


def num(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def distill(d):
    """Turn his raw indicator dict into the compact read the desk shows."""
    price = num(d.get("close"))
    rsi = num(d.get("rsi_14"))
    adx = num(d.get("adx_14"))
    plus_di = d.get("plus_di")
    minus_di = d.get("minus_di")
    ema89 = d.get("ema_89")
    sma200 = d.get("sma_200")
    hist = d.get("macd_histogram")
    atr = d.get("atr_14")
    stack_bull = bool(d.get("ema_stack_bullish"))

    di_bull = (plus_di is not None and minus_di is not None and plus_di > minus_di)
    above_stack = (price is not None and ema89 is not None and price > ema89)
    above_200 = (price is not None and sma200 is not None and price > sma200)

    # ADX strength buckets (Wilder): <20 weak/no trend, 20-25 forming,
    # 25-40 strong, >40 very strong.
    if adx is None:
        adx_note = None
    elif adx >= 40:
        adx_note = "very strong trend"
    elif adx >= 25:
        adx_note = "strong trend"
    elif adx >= 20:
        adx_note = "trend forming"
    else:
        adx_note = "choppy / no trend"

    # Trend read blends ADX strength, DI direction, and EMA stack.
    strong = adx is not None and adx >= 25
    if strong and di_bull and above_stack:
        trend = "strong uptrend"
    elif di_bull and above_stack:
        trend = "uptrend"
    elif strong and not di_bull and not above_stack:
        trend = "strong downtrend"
    elif not di_bull and not above_stack:
        trend = "downtrend"
    else:
        trend = "mixed"

    # 0-100 momentum score.
    score = 50
    if above_stack:
        score += 10
    if above_200:
        score += 10
    if stack_bull:
        score += 12
    if di_bull:
        score += 8
    else:
        score -= 8
    if hist is not None and hist > 0:
        score += 8
    if hist is not None and hist < 0:
        score -= 8
    if adx is not None and adx >= 25:
        score += (6 if di_bull else -6)
    if rsi is not None and rsi >= 70:
        score -= 5
    if rsi is not None and rsi <= 30:
        score += 5
    score = max(0, min(100, round(score)))

    rsi_note = None
    if rsi is not None:
        rsi_note = "overbought" if rsi >= 70 else "oversold" if rsi <= 30 else "neutral"

    atr_pct = None
    if atr is not None and price:
        atr_pct = round(float(atr) / price * 100, 1)

    analysis = d.get("analysis")
    if isinstance(analysis, str) and len(analysis) > 320:
        analysis = analysis[:319].rstrip() + "…"

    return {
        "price": price,
        "trend": trend,
        "score": score,
        "rsi": rsi,
        "rsiNote": rsi_note,
        "macdDir": None if hist is None else ("rising" if hist > 0 else "falling"),
        "adx": adx,
        "adxNote": adx_note,
        "diDir": None if plus_di is None else ("bull" if di_bull else "bear"),
        "atrPct": atr_pct,
        "sma50": num(d.get("sma_50")),
        "sma200": num(d.get("sma_200")),
        "emaStackBull": stack_bull,
        "aboveStack": above_stack,
        "analysis": analysis,
    }


async def run():
    book = read_json("book.json", {"positions": []})
    watch = read_json("watch.json", {"tickers": []})
    tickers = set()
    for p in book.get("positions", []):
        if p.get("t"):
            tickers.add(str(p["t"]).upper())
    for t in watch.get("tickers", []):
        if t:
            tickers.add(str(t).upper())
    tickers = sorted(tickers)
    if not tickers:
        raise SystemExit("no tickers to analyze")

    out = {}
    ok = 0
    for t in tickers:
        try:
            res = await analyze_technicals(t)
            data = res.data if hasattr(res, "data") else None
            if getattr(res, "status", None) == "success" and isinstance(data, dict):
                out[t] = distill(data)
                ok += 1
            else:
                out[t] = {"error": getattr(res, "error", None) or "no data"}
        except Exception as e:  # noqa: BLE001
            out[t] = {"error": str(e)[:80]}

    from datetime import datetime, timezone

    write_both("signals.json", {
        "updated": datetime.now(timezone.utc).isoformat(),
        "method": "mphinance/momentum-mcp analyze_technicals (RSI, MACD, EMA 8/21/34/55/89, SMA, ADX+DI, ATR, Bollinger)",
        "signals": out,
    })
    print(f"signals_pro: analyzed {ok}/{len(tickers)} tickers with the momentum engine")


if __name__ == "__main__":
    asyncio.run(run())
