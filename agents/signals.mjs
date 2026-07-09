#!/usr/bin/env node
// signals: real technical signals per book + watchlist ticker.
//
// Methodology from mphinance/momentum-mcp (the momentum engine Quinn builds
// on): the 8/21/34/55/89 EMA momentum stack, RSI(14), and MACD(12,26,9),
// ported to the desk's zero-dependency Node so it runs free on Actions with
// no Python/pandas setup. Pulls one year of daily closes from the Yahoo v8
// chart API (same source as price-agent) and writes signals.json (both
// copies) for the desk to render.
//
// Run: node agents/signals.mjs

import {
  fail,
  fetchWithTimeout,
  nowISO,
  readJson,
  round,
  updateOffice,
  writeJsonBoth,
} from './lib.mjs';

const AGENT_ID = 'signals';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 yb-desk/1.0',
  Accept: 'application/json',
};
const TIMEOUT_MS = 9000;
const EMA_STACK = [8, 21, 34, 55, 89]; // Michael's signature momentum stack

function ema(values, period) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

// Wilder's RSI(14) on a close series.
function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return round(100 - 100 / (1 + rs), 1);
}

// MACD(12,26,9): returns { macd, signal, hist } on the latest bar.
function macd(values) {
  if (values.length < 35) return null;
  const e12 = ema(values, 12);
  const e26 = ema(values, 26);
  const macdLine = values.map((_, i) => e12[i] - e26[i]);
  const signalLine = ema(macdLine.slice(25), 9); // start once e26 is meaningful
  const macdNow = macdLine[macdLine.length - 1];
  const signalNow = signalLine[signalLine.length - 1];
  return {
    macd: round(macdNow, 3),
    signal: round(signalNow, 3),
    hist: round(macdNow - signalNow, 3),
  };
}

// The read: where price sits against the EMA stack, whether the stack is
// in bullish order (fast over slow), plus RSI and MACD context.
function computeSignal(closes) {
  const price = closes[closes.length - 1];
  const emas = {};
  EMA_STACK.forEach((p) => {
    if (closes.length > p) {
      const series = ema(closes, p);
      emas[p] = round(series[series.length - 1], 2);
    }
  });
  const present = EMA_STACK.filter((p) => emas[p] != null);
  const stackVals = present.map((p) => emas[p]);
  // Bullish stack = each faster EMA above the next slower one.
  let stackedBull = stackVals.length >= 2;
  let stackedBear = stackVals.length >= 2;
  for (let i = 0; i < stackVals.length - 1; i++) {
    if (!(stackVals[i] > stackVals[i + 1])) stackedBull = false;
    if (!(stackVals[i] < stackVals[i + 1])) stackedBear = false;
  }
  const aboveFast = emas[8] != null && price > emas[8];
  const aboveSlow = emas[89] != null && price > emas[89];
  const r = rsi(closes);
  const m = macd(closes);

  // Plain-language trend verdict.
  let trend;
  if (stackedBull && aboveFast) trend = 'strong uptrend';
  else if (aboveSlow && aboveFast) trend = 'uptrend';
  else if (stackedBear && !aboveFast) trend = 'strong downtrend';
  else if (!aboveSlow && !aboveFast) trend = 'downtrend';
  else trend = 'mixed';

  // A simple 0-100 momentum score from the pieces we trust.
  let score = 50;
  if (aboveSlow) score += 12;
  if (aboveFast) score += 10;
  if (stackedBull) score += 15;
  if (stackedBear) score -= 15;
  if (m && m.hist > 0) score += 8;
  if (m && m.hist < 0) score -= 8;
  if (r != null && r >= 70) score -= 5; // overbought caution
  if (r != null && r <= 30) score += 5; // oversold bounce room
  score = Math.max(0, Math.min(100, Math.round(score)));

  const rsiNote = r == null ? null : r >= 70 ? 'overbought' : r <= 30 ? 'oversold' : 'neutral';

  return {
    price: round(price, 2),
    trend,
    score,
    rsi: r,
    rsiNote,
    macd: m,
    emaStack: emas,
    aboveStack: aboveSlow,
  };
}

async function fetchCloses(ticker) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  const res = await fetchWithTimeout(url, { headers: HEADERS }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const result = payload?.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close ?? []).filter(
    (c) => typeof c === 'number' && Number.isFinite(c),
  );
  return closes;
}

async function main() {
  const book = await readJson('book.json', { positions: [] });
  const watch = await readJson('watch.json', { tickers: [] });
  const set = new Set();
  (book.positions ?? []).forEach((p) => { if (p?.t) set.add(String(p.t).toUpperCase()); });
  (watch.tickers ?? []).forEach((t) => { if (t) set.add(String(t).toUpperCase()); });
  const tickers = [...set].sort();
  if (!tickers.length) throw new Error('no tickers to analyze');

  const signals = {};
  let ok = 0;
  for (const t of tickers) {
    try {
      const closes = await fetchCloses(t);
      if (closes.length < 30) { signals[t] = { error: 'not enough history' }; continue; }
      signals[t] = computeSignal(closes);
      ok += 1;
    } catch (e) {
      signals[t] = { error: String(e.message).slice(0, 60) };
    }
  }

  await writeJsonBoth('signals.json', {
    updated: nowISO(),
    method: 'mphinance/momentum-mcp EMA stack 8/21/34/55/89 + RSI(14) + MACD(12,26,9), ported to zero-dep Node',
    signals,
  });
  await updateOffice(AGENT_ID, 'ok');
  console.log(`signals: analyzed ${ok}/${tickers.length} tickers`);
}

main().catch((err) => fail(AGENT_ID, err.message));
