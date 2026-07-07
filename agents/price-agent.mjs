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
const YB_QUOTES_BASE = 'https://youngbullinvests.com/api/quotes';
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 yb-desk/1.0',
  Accept: 'application/json',
};
const TIMEOUT_MS = 8000;
const FALLBACK_TIMEOUT_MS = 10000;

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

// Fallback: batch-fetch the tickers Yahoo could not serve from the public
// youngbullinvests quotes endpoint. Same contract as the client fallback:
// { ok, quotes: { T: { price, prevClose, changePct } | null } }. Returns a map
// of ticker -> { price, changePct } for whatever it could resolve.
async function fetchFallbackQuotes(tickers) {
  if (tickers.length === 0) return {};
  const url = `${YB_QUOTES_BASE}?tickers=${tickers.map(encodeURIComponent).join(',')}`;
  const res = await fetchWithTimeout(url, { headers: REQUEST_HEADERS }, FALLBACK_TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const quotes = payload?.quotes ?? {};
  const resolved = {};
  for (const ticker of tickers) {
    const q = quotes[ticker];
    if (q && typeof q.price === 'number' && Number.isFinite(q.price)) {
      const changePct =
        typeof q.changePct === 'number' && Number.isFinite(q.changePct)
          ? round(q.changePct, 4)
          : null;
      resolved[ticker] = { price: round(q.price, 4), changePct };
    }
  }
  return resolved;
}

async function main() {
  const book = await readJson('book.json');
  const watch = await readJson('watch.json', { tickers: [] });
  const previous = await readJson('prices.json', { quotes: {} });

  const universe = buildUniverse(book, watch);
  if (universe.length === 0) throw new Error('empty ticker universe');

  const settled = await Promise.allSettled(universe.map((t) => fetchQuote(t)));
  const quotes = { ...(previous.quotes ?? {}) };
  const yahooMissed = [];
  let fresh = 0;
  settled.forEach((outcome, i) => {
    const ticker = universe[i];
    if (outcome.status === 'fulfilled') {
      quotes[ticker] = outcome.value;
      fresh += 1;
    } else {
      yahooMissed.push(ticker);
    }
  });

  // Any ticker Yahoo could not serve gets a second attempt against the
  // youngbullinvests quotes endpoint before falling back to the previous quote.
  let recovered = [];
  if (yahooMissed.length) {
    try {
      const fallbackQuotes = await fetchFallbackQuotes(yahooMissed);
      recovered = Object.keys(fallbackQuotes);
      for (const ticker of recovered) quotes[ticker] = fallbackQuotes[ticker];
    } catch (err) {
      console.error(`price-agent: fallback quotes failed: ${err.message}`);
    }
  }

  const stillMissing = yahooMissed.filter((t) => !recovered.includes(t));
  if (fresh === 0 && recovered.length === 0) {
    throw new Error(`all ${universe.length} quote fetches failed`);
  }

  await writeJsonBoth('prices.json', { updated: nowISO(), quotes });
  await updateOffice(AGENT_ID, 'ok');
  const recoveredNote = recovered.length
    ? `, ${recovered.length} recovered via youngbullinvests: ${recovered.join(' ')}`
    : '';
  const skippedNote = stillMissing.length
    ? `, ${stillMissing.length} kept previous quote: ${stillMissing.join(' ')}`
    : '';
  console.log(
    `price-agent: ${fresh}/${universe.length} quotes fresh from Yahoo${recoveredNote}${skippedNote}`,
  );
}

main().catch((err) => fail(AGENT_ID, err.message));
