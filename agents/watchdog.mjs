#!/usr/bin/env node
// watchdog: flags any book ticker with an absolute day move of 5% or more.
// Reads prices.json, writes alerts.json (replaced on every run, no append).
// Run: node agents/watchdog.mjs

import { fail, fmtPct, nowISO, readJson, updateOffice, writeJsonBoth } from './lib.mjs';

const AGENT_ID = 'watchdog';
const THRESHOLD_PCT = 5;

function buildAlerts(bookTickers, quotes, flaggedAt) {
  return bookTickers
    .map((ticker) => ({ ticker, quote: quotes[ticker] }))
    .filter(
      ({ quote }) =>
        typeof quote?.changePct === 'number' && Math.abs(quote.changePct) >= THRESHOLD_PCT,
    )
    .map(({ ticker, quote }) => ({ ticker, changePct: quote.changePct, flaggedAt }))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

async function main() {
  const book = await readJson('book.json');
  const prices = await readJson('prices.json');
  const bookTickers = (book?.positions ?? [])
    .map((pos) => String(pos?.t || '').toUpperCase())
    .filter(Boolean);
  if (!bookTickers.length) throw new Error('book.json has no positions');

  const flaggedAt = nowISO();
  const alerts = buildAlerts(bookTickers, prices?.quotes ?? {}, flaggedAt);
  await writeJsonBoth('alerts.json', { updated: flaggedAt, alerts });
  await updateOffice(AGENT_ID, 'ok');

  const summary = alerts.length
    ? alerts.map((a) => `${a.ticker} ${fmtPct(a.changePct)}`).join(', ')
    : 'no flags';
  console.log(`watchdog: ${alerts.length} flags at ${THRESHOLD_PCT}% threshold: ${summary}`);
}

main().catch((err) => fail(AGENT_ID, err.message));
