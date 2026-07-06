#!/usr/bin/env node
// price-agent: pulls quotes for the book + watchlist universe from the Yahoo
// v8 chart API and writes prices.json. Failed tickers keep their previous
// quote so data is merged, never lost.
// Run: node agents/price-agent.mjs

import {
  fail,
  fetchWithTimeout,
  nowISO,
  readJson,
  round,
  updateOffice,
  writeJsonBoth,
} from './lib.mjs';

const AGENT_ID = 'price-agent';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 yb-desk/1.0',
  Accept: 'application/json',
};
const TIMEOUT_MS = 8000;

function buildUniverse(book, watch) {
  const tickers = new Set();
  for (const pos of book?.positions ?? []) {
    if (pos?.t) tickers.add(String(pos.t).toUpperCase());
  }
  for (const t of watch?.tickers ?? []) {
    if (t) tickers.add(String(t).toUpperCase());
  }
  return [...tickers].sort();
}

async function fetchQuote(ticker) {
  const url = `${YAHOO_BASE}/${encodeURIComponent(ticker)}?range=2d&interval=1d`;
  const res = await fetchWithTimeout(url, { headers: REQUEST_HEADERS }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const result = payload?.chart?.result?.[0];
  if (!result) {
    throw new Error(payload?.chart?.error?.description || 'empty chart result');
  }
  const meta = result.meta ?? {};
  const closes = (result.indicators?.quote?.[0]?.close ?? []).filter(
    (c) => typeof c === 'number' && Number.isFinite(c),
  );
  const price =
    typeof meta.regularMarketPrice === 'number' ? meta.regularMarketPrice : closes.at(-1);
  if (typeof price !== 'number') throw new Error('no usable price in response');
  const prevClose = closes.length >= 2 ? closes.at(-2) : meta.chartPreviousClose;
  const changePct =
    typeof prevClose === 'number' && prevClose !== 0
      ? round(((price - prevClose) / prevClose) * 100, 4)
      : null;
  return { price: round(price, 4), changePct };
}

async function main() {
  const book = await readJson('book.json');
  const watch = await readJson('watch.json', { tickers: [] });
  const previous = await readJson('prices.json', { quotes: {} });

  const universe = buildUniverse(book, watch);
  if (universe.length === 0) throw new Error('empty ticker universe');

  const settled = await Promise.allSettled(universe.map((t) => fetchQuote(t)));
  const quotes = { ...(previous.quotes ?? {}) };
  const skipped = [];
  let fresh = 0;
  settled.forEach((outcome, i) => {
    const ticker = universe[i];
    if (outcome.status === 'fulfilled') {
      quotes[ticker] = outcome.value;
      fresh += 1;
    } else {
      skipped.push(ticker);
    }
  });
  if (fresh === 0) throw new Error(`all ${universe.length} quote fetches failed`);

  await writeJsonBoth('prices.json', { updated: nowISO(), quotes });
  await updateOffice(AGENT_ID, 'ok');
  const skippedNote = skipped.length
    ? `, ${skipped.length} skipped kept previous quote: ${skipped.join(' ')}`
    : '';
  console.log(`price-agent: ${fresh}/${universe.length} quotes fresh${skippedNote}`);
}

main().catch((err) => fail(AGENT_ID, err.message));
