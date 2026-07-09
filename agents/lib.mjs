// Shared helpers for yb-desk agents.
// Zero dependencies. Node 20 built-ins and global fetch only.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const DOCS_DATA_DIR = path.join(ROOT, 'docs', 'data');

export function nowISO() {
  return new Date().toISOString();
}

export function todayISO() {
  return nowISO().slice(0, 10);
}

export function round(value, decimals = 2) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function fmtPct(value) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(text, max = 300) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

// Voice rule: no em dashes in user-facing copy. Replace with ', '.
export function stripEmDashes(text) {
  return text.replace(/\s*[—―]+\s*/g, ', ');
}

// Read a JSON file from data/. Returns fallback if unreadable and one is given.
export async function readJson(relPath, fallback) {
  try {
    const raw = await readFile(path.join(DATA_DIR, relPath), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new Error(`cannot read data/${relPath}: ${err.message}`);
  }
}

// Write the same file under data/ and docs/data/ so the dashboard stays in sync.
export async function writeTextBoth(relPath, body) {
  const targets = [path.join(DATA_DIR, relPath), path.join(DOCS_DATA_DIR, relPath)];
  for (const target of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body, 'utf8');
  }
}

export async function writeJsonBoth(relPath, value) {
  await writeTextBoth(relPath, `${JSON.stringify(value, null, 2)}\n`);
}

const OFFICE_AGENTS = [
  { id: 'book-sync', name: 'Book Sync', job: 'pulls Quinn\'s live book daily' },
  { id: 'price-agent', name: 'Price Agent', role: 'Pulls live quotes for the book and watchlist' },
  { id: 'desk-report', name: 'Desk Report', role: 'Writes the deterministic daily desk report' },
  { id: 'watchdog', name: 'Watchdog', role: 'Flags book tickers moving 5 percent or more' },
  { id: 'research-agent', name: 'Research Agent', role: 'Runs on-demand ticker research briefs' },
  { id: 'member-alerts', name: 'Member Alerts', role: 'Emails opted-in members when their names move past their threshold' },
  { id: 'signals', name: 'Signals', role: 'Real technicals per name: EMA stack, RSI, MACD, trend read' },
  { id: 'sentinel', name: 'Sentinel', role: 'Verifies every data feed hourly and restarts anything that dies' },
];

export function officeSeed() {
  return {
    updated: nowISO(),
    agents: OFFICE_AGENTS.map((agent) => ({ ...agent, lastRun: null, lastStatus: null })),
  };
}

// Record an agent run in office.json (both copies). Creates the seed if missing.
// A new agent that is in the OFFICE_AGENTS roster is appended with its seed
// metadata (name, job/role) so the office card reads correctly on first run.
export async function updateOffice(agentId, status) {
  const current = await readJson('office.json', null);
  const base = current && Array.isArray(current.agents) ? current : officeSeed();
  const known = base.agents.some((agent) => agent.id === agentId);
  const stamped = { lastRun: nowISO(), lastStatus: status };
  const seedMeta = OFFICE_AGENTS.find((agent) => agent.id === agentId) || {
    id: agentId,
    name: agentId,
    role: '',
  };
  const agents = known
    ? base.agents.map((agent) => (agent.id === agentId ? { ...agent, ...stamped } : agent))
    : [...base.agents, { ...seedMeta, lastRun: null, lastStatus: null, ...stamped }];
  await writeJsonBoth('office.json', { ...base, updated: nowISO(), agents });
}

// Upsert one entry into reports-index.json (both copies), newest first.
export async function updateReportsIndex(entry) {
  const current = await readJson('reports-index.json', { reports: [] });
  const rest = (Array.isArray(current.reports) ? current.reports : []).filter(
    (report) => report.file !== entry.file,
  );
  const reports = [entry, ...rest].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  await writeJsonBoth('reports-index.json', { updated: nowISO(), reports });
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Record the failure in office.json, print a readable error, exit nonzero.
export async function fail(agentId, message) {
  try {
    await updateOffice(agentId, `error: ${truncate(message, 200)}`);
  } catch {
    // office.json write failed too; the exit code still signals the failure
  }
  console.error(`${agentId}: ERROR: ${message}`);
  process.exit(1);
}

// killVectors appear as [{ title, body }] or as plain strings. Normalize to lines.
export function killVectorLines(killVectors) {
  if (!Array.isArray(killVectors)) return [];
  return killVectors
    .map((kv) => {
      if (typeof kv === 'string') return kv;
      const title = kv?.title && kv.title !== 'Kill vector' ? `${kv.title}: ` : '';
      return kv?.body ? `${title}${kv.body}` : '';
    })
    .filter(Boolean);
}
