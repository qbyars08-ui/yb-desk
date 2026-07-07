#!/usr/bin/env node
// book-sync: pulls Quinn's live book from youngbullinvests.com and writes it to
// book.json (both copies). This replaces the old manual snapshot so renamed
// tickers and new positions flow through automatically. Runs first in the daily
// cycle, before price-agent and desk-report.
//
// Safety: refuses to overwrite on a suspicious shrink (positions dropping more
// than 30 percent vs the current file) or on a malformed response.
// Run: node agents/book-sync.mjs

import {
  fail,
  fetchWithTimeout,
  nowISO,
  readJson,
  updateOffice,
  writeJsonBoth,
} from './lib.mjs';

const AGENT_ID = 'book-sync';
const LIVE_URL = 'https://youngbullinvests.com/api/portfolio-live';
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 yb-desk/1.0',
  Accept: 'application/json',
};
const TIMEOUT_MS = 10000;
const MIN_POSITIONS = 10;
const MAX_SHRINK_PCT = 30;

function validateBook(book) {
  if (!book || typeof book !== 'object') return 'response is not an object';
  if (book.ok !== true) return 'response ok flag is not true';
  if (!Array.isArray(book.positions)) return 'positions is not an array';
  if (book.positions.length <= MIN_POSITIONS) {
    return `only ${book.positions.length} positions, expected more than ${MIN_POSITIONS}`;
  }
  const missingTicker = book.positions.find(
    (pos) => !pos || typeof pos.t !== 'string' || pos.t.trim() === '',
  );
  if (missingTicker) return 'at least one position is missing a t field';
  return null;
}

function shrinkGuard(nextCount, currentCount) {
  if (currentCount <= 0) return null;
  const shrinkPct = ((currentCount - nextCount) / currentCount) * 100;
  if (shrinkPct > MAX_SHRINK_PCT) {
    return `refusing to overwrite: position count would shrink ${shrinkPct.toFixed(
      1,
    )}% (from ${currentCount} to ${nextCount}), over the ${MAX_SHRINK_PCT}% guard`;
  }
  return null;
}

async function main() {
  const res = await fetchWithTimeout(LIVE_URL, { headers: REQUEST_HEADERS }, TIMEOUT_MS);
  if (!res.ok) throw new Error(`HTTP ${res.status} from portfolio-live`);
  const book = await res.json();

  const invalid = validateBook(book);
  if (invalid) throw new Error(invalid);

  const current = await readJson('book.json', { positions: [] });
  const currentCount = Array.isArray(current.positions) ? current.positions.length : 0;
  const guard = shrinkGuard(book.positions.length, currentCount);
  if (guard) throw new Error(guard);

  await writeJsonBoth('book.json', book);
  await updateOffice(AGENT_ID, 'ok');

  const tickers = book.positions.map((pos) => String(pos.t).toUpperCase());
  console.log(
    `book-sync: wrote book.json with ${book.positions.length} positions (was ${currentCount})`,
  );
  console.log(`book-sync: tickers ${tickers.join(' ')}`);
}

main().catch((err) => fail(AGENT_ID, err.message));
