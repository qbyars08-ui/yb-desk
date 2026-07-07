#!/usr/bin/env node
// desk-report: deterministic daily report. No LLM anywhere in this file.
// Reads book.json + prices.json, writes reports/<date>.md and updates
// reports-index.json under both data/ and docs/data/.
// Run: node agents/desk-report.mjs

import {
  fail,
  fmtPct,
  readJson,
  round,
  todayISO,
  updateOffice,
  updateReportsIndex,
  writeJsonBoth,
  writeTextBoth,
} from './lib.mjs';

const AGENT_ID = 'desk-report';
const HISTORY_MAX_POINTS = 380;
const HISTORY_CLOSE_DECIMALS = 4;

// Append today's close to history.json for every ticker with a live quote,
// deduping the same-date entry (replace), adding new tickers automatically,
// keeping the MAX cap, and pruning tickers that are in neither the book nor
// prices and have grown past the cap. Never throws: any failure is logged and
// swallowed so the daily report is never blocked by history maintenance.
async function appendHistory(positions, quotes, date) {
  try {
    const history = await readJson('history.json', { updated: null, series: {} });
    const series = { ...(history.series ?? {}) };

    const bookTickers = new Set(
      positions.map((pos) => String(pos.t || '').toUpperCase()).filter(Boolean),
    );
    const priceTickers = new Set(Object.keys(quotes).map((t) => t.toUpperCase()));

    let appended = 0;
    for (const rawTicker of priceTickers) {
      const ticker = rawTicker.toUpperCase();
      const price = quotes[rawTicker]?.price;
      if (typeof price !== 'number' || !Number.isFinite(price)) continue;
      const existing = Array.isArray(series[ticker]) ? series[ticker] : [];
      const deduped = existing.filter((pair) => pair[0] !== date);
      deduped.push([date, round(price, HISTORY_CLOSE_DECIMALS)]);
      deduped.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      series[ticker] = deduped.slice(-HISTORY_MAX_POINTS);
      appended += 1;
    }

    // Prune tickers absent from both book and prices once they exceed the cap.
    for (const ticker of Object.keys(series)) {
      const kept = bookTickers.has(ticker) || priceTickers.has(ticker) || ticker === 'SPY';
      if (!kept && series[ticker].length > HISTORY_MAX_POINTS) {
        delete series[ticker];
      }
    }

    await writeJsonBoth('history.json', { updated: new Date().toISOString(), series });
    console.log(`desk-report: history append touched ${appended} tickers`);
  } catch (err) {
    console.error(`desk-report: history append skipped (${err.message})`);
  }
}

function effectiveChanges(positions, quotes) {
  return positions
    .map((pos) => {
      const ticker = String(pos.t || '').toUpperCase();
      const quote = quotes[ticker];
      const change =
        typeof quote?.changePct === 'number' ? quote.changePct : pos.dayChangePct;
      return { ticker, change };
    })
    .filter((row) => row.ticker && typeof row.change === 'number' && Number.isFinite(row.change));
}

function moversSection(rows) {
  const up = rows.filter((r) => r.change > 0).sort((a, b) => b.change - a.change).slice(0, 3);
  const down = rows.filter((r) => r.change < 0).sort((a, b) => a.change - b.change).slice(0, 3);
  const fmt = (list) => list.map((r) => `${r.ticker} ${fmtPct(r.change)}`).join(', ');
  const lines = ['## Movers', ''];
  lines.push(up.length ? `Top gainers on the book today: ${fmt(up)}.` : 'No book names are up today.');
  lines.push(down.length ? `Top decliners: ${fmt(down)}.` : 'No book names are down today.');
  return { lines, upCount: up.length, downCount: down.length };
}

function concentrationSection(positions) {
  const weighted = positions
    .filter((pos) => typeof pos.weightPct === 'number' && Number.isFinite(pos.weightPct))
    .sort((a, b) => b.weightPct - a.weightPct)
    .slice(0, 3);
  const lines = ['## Concentration', ''];
  if (!weighted.length) {
    lines.push('No position weights available.');
    return lines;
  }
  const parts = weighted.map((pos) => `${pos.t} at ${pos.weightPct.toFixed(2)}%`).join(', ');
  const total = round(weighted.reduce((sum, pos) => sum + pos.weightPct, 0), 2);
  lines.push(`The largest weights are ${parts}. Together they are ${total}% of the book.`);
  return lines;
}

function milestoneSection(positions) {
  const hits = positions
    .filter((pos) => typeof pos.gainPctAtBase === 'number' && pos.gainPctAtBase >= 100)
    .sort((a, b) => b.gainPctAtBase - a.gainPctAtBase)
    .map((pos) => {
      const milestone = Math.floor(pos.gainPctAtBase / 100) * 100;
      return `${pos.t} is past the ${milestone}% gain milestone, up ${fmtPct(pos.gainPctAtBase)} from base.`;
    });
  const lines = ['## Milestones', ''];
  if (!hits.length) {
    lines.push('No positions past a 100% gain milestone.');
    return { lines, count: 0 };
  }
  return { lines: [...lines, ...hits], count: hits.length };
}

async function main() {
  const book = await readJson('book.json');
  const prices = await readJson('prices.json', { quotes: {} });
  const positions = Array.isArray(book?.positions) ? book.positions : [];
  if (!positions.length) throw new Error('book.json has no positions');

  const date = todayISO();
  const movers = moversSection(effectiveChanges(positions, prices.quotes ?? {}));
  const milestones = milestoneSection(positions);
  const body = [
    `# Desk Report ${date}`,
    '',
    ...movers.lines,
    '',
    ...concentrationSection(positions),
    '',
    ...milestones.lines,
    '',
    'Numbers computed from the tape. No AI wrote this.',
    '',
    'Not investment advice. Your money, your call.',
    '',
  ].join('\n');

  const file = `reports/${date}.md`;
  await writeTextBoth(file, body);
  await updateReportsIndex({ file, date, title: `Desk Report ${date}`, type: 'desk' });
  await appendHistory(positions, prices.quotes ?? {}, date);
  await updateOffice(AGENT_ID, 'ok');
  console.log(
    `desk-report: wrote ${file} (${movers.upCount} up, ${movers.downCount} down, ${milestones.count} milestones)`,
  );
}

main().catch((err) => fail(AGENT_ID, err.message));
