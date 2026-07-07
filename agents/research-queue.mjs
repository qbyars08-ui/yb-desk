// research-queue: bridges the website queue to the research agent.
//
// Non-technical visitors POST a ticker at the site (youngbullinvests.com
// /api/desk-research). This worker polls that queue on a cron, runs the
// research agent for each new request, and advances a cursor committed to
// the repo so nothing is processed twice.
//
// Env: GROQ_API_KEY (required, passed through to research-agent).
// Run: node agents/research-queue.mjs

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const QUEUE_URL = 'https://youngbullinvests.com/api/desk-research?since=';
const CURSOR_PATHS = ['data/research-cursor.json', 'docs/data/research-cursor.json'];
const MAX_PER_RUN = 3; // bound Groq spend and run time; leftovers next cycle
const TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;

function readCursor() {
  try {
    if (existsSync(CURSOR_PATHS[0])) {
      return Number(JSON.parse(readFileSync(CURSOR_PATHS[0], 'utf8')).lastId) || 0;
    }
  } catch { /* corrupted cursor: start from 0, dedupe is by id so worst case is a re-run */ }
  return 0;
}

function writeCursor(lastId) {
  const body = JSON.stringify({ lastId, updated: new Date().toISOString() }) + '\n';
  for (const p of CURSOR_PATHS) writeFileSync(p, body);
}

async function main() {
  const since = readCursor();
  const res = await fetch(QUEUE_URL + since, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`queue fetch HTTP ${res.status}`);
  const data = await res.json();
  const requests = (data && data.ok && Array.isArray(data.requests)) ? data.requests : [];
  if (!requests.length) {
    console.log(`research-queue: no new requests past id ${since}`);
    return;
  }

  let processed = 0;
  let lastId = since;
  for (const r of requests) {
    lastId = Math.max(lastId, Number(r.id) || 0);
    const ticker = String(r.ticker || '').toUpperCase();
    if (!TICKER_RE.test(ticker)) continue; // endpoint validates, belt and suspenders
    if (processed >= MAX_PER_RUN) { lastId = Number(r.id) - 1; break; } // resume here next cycle
    try {
      execFileSync('node', ['agents/research-agent.mjs'], {
        env: { ...process.env, TICKER: ticker, QUESTION: String(r.question || '') },
        stdio: ['ignore', 'ignore', 'inherit'],
        timeout: 180_000,
      });
      processed++;
      console.log(`research-queue: brief written for ${ticker} (request ${r.id})`);
    } catch (e) {
      // One bad ticker never blocks the queue; cursor still advances past it.
      console.error(`research-queue: ${ticker} failed: ${e.message}`);
    }
  }

  writeCursor(lastId);
  console.log(`research-queue: processed ${processed}, cursor now ${lastId}`);
}

main().catch((e) => { console.error('research-queue FAILED:', e.message); process.exit(1); });
