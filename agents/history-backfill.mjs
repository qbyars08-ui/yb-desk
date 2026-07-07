#!/usr/bin/env node
// history-backfill: one-time (and re-runnable) 1-year daily-close backfill for
// every book ticker plus SPY, pulled from the Yahoo v8 chart API. Writes
// data/history.json (+ docs/data mirror) as { updated, series: { T: [[date, close], ...] } }.
// Closes are rounded, finite-only, ascending by date, capped to the most recent
// MAX_POINTS per ticker. Yahoo failures are skipped with a warning; the run only
// fails if it cannot land any series at all.
// Run: node agents/history-backfill.mjs

import {
  fail,
  fetchWithTimeout,
  nowISO,
  readJson,
  round,
  writeJsonBoth,
} from './lib.mjs';

const AGENT_ID = 'history-backfill';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 yb-desk/1.0',
  Accept: 'application/json',
};
const TIMEOUT_MS = 8000;
const MAX_POINTS = 380;
const CLOSE_DECIMALS = 4;

function buildUniverse(book) {
  const tickers = new Set(['SPY']);
  for (const pos of book?.positions ?? []) {
    if (pos?.t) tickers.add(String(pos.t).toUpperCase());
  }
  return [...tickers].sort();
}

// Turn a Yahoo chart payload into ascending [date, close] pairs, finite closes
// only, deduped by date (last write wins), capped to the most recent MAX_POINTS.
function parseSeries(payload) {
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(payload?.chart?.error?.description || 'empty chart result');
  }
  const stamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const closes = result.indicators?.quote?.[0]?.close ?? [];
  const byDate = new Map();
  for (let i = 0; i < stamps.length; i += 1) {
    const ts = stamps[i];
    const close = closes[i];
    if (typeof ts !== 'number' || typeof close !== 'number' || !Number.isFinite(close)) {
      continue;
    }
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    byDate.set(date, round(close, CLOSE_DECIMALS));
  }
  const pairs = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return pairs.slice(-MAX_POINTS);
}

async function fetchSeries(ticker) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
  const res = await fetchWithTimeout(url, { headers: REQUEST_HEADERS }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  return parseSeries(payload);
}

async function main() {
  const book = await readJson('book.json');
  const universe = buildUniverse(book);
  if (universe.length === 0) throw new Error('empty ticker universe');

  const settled = await Promise.allSettled(universe.map((t) => fetchSeries(t)));
  const series = {};
  const landed = [];
  const skipped = [];
  settled.forEach((outcome, i) => {
    const ticker = universe[i];
    if (outcome.status === 'fulfilled' && outcome.value.length > 0) {
      series[ticker] = outcome.value;
      landed.push(`${ticker}:${outcome.value.length}`);
    } else {
      const reason = outcome.status === 'rejected' ? outcome.reason?.message : 'no points';
      skipped.push(ticker);
      console.warn(`history-backfill: skipped ${ticker} (${reason})`);
    }
  });

  if (Object.keys(series).length === 0) {
    throw new Error(`all ${universe.length} history fetches failed`);
  }

  await writeJsonBoth('history.json', { updated: nowISO(), series });
  console.log(
    `history-backfill: ${Object.keys(series).length}/${universe.length} tickers landed` +
      (skipped.length ? `, skipped: ${skipped.join(' ')}` : ''),
  );
  console.log(`history-backfill: points ${landed.join(' ')}`);
}

main().catch((err) => fail(AGENT_ID, err.message));
