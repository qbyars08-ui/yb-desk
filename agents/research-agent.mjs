#!/usr/bin/env node
// research-agent: on-demand ticker research brief via Groq.
// Env: TICKER (required), GROQ_API_KEY (required), ISSUE_NUMBER (optional).
// Prints the finished report to stdout so the workflow can post it as an
// issue comment. Status lines go to stderr to keep stdout clean.
// Run: TICKER=MU GROQ_API_KEY=... node agents/research-agent.mjs

import {
  fail,
  fetchWithTimeout,
  killVectorLines,
  readJson,
  sleep,
  stripEmDashes,
  todayISO,
  truncate,
  updateOffice,
  updateReportsIndex,
  writeTextBoth,
} from './lib.mjs';

const AGENT_ID = 'research-agent';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = 'openai/gpt-oss-120b';
const TICKER_PATTERN = /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/;
const RETRY_DELAY_MS = 10_000;
const GROQ_TIMEOUT_MS = 60_000;

function readEnv() {
  const rawTicker = process.env.TICKER ?? '';
  if (!rawTicker) throw new Error('TICKER env var is required');
  if (!TICKER_PATTERN.test(rawTicker)) throw new Error(`invalid TICKER: ${rawTicker}`);
  const apiKey = process.env.GROQ_API_KEY ?? '';
  if (!apiKey) throw new Error('GROQ_API_KEY env var is required');
  const rawIssue = process.env.ISSUE_NUMBER ?? '';
  const issueNumber = /^\d+$/.test(rawIssue) ? Number(rawIssue) : null;
  if (rawIssue && issueNumber === null) {
    console.error(`research-agent: ignoring malformed ISSUE_NUMBER: ${rawIssue}`);
  }
  return { ticker: rawTicker.toUpperCase(), apiKey, issueNumber };
}

function positionContext(pos) {
  const lines = ['This ticker is HELD in the Young Bull book. Real position context:'];
  if (pos.sleeve) lines.push(`Sleeve: ${pos.sleeve}. Layer: ${pos.layer ?? 'n/a'}.`);
  if (typeof pos.weightPct === 'number') lines.push(`Weight: ${pos.weightPct.toFixed(2)}% of the book.`);
  if (typeof pos.gainPctAtBase === 'number') lines.push(`Gain since base: ${pos.gainPctAtBase.toFixed(2)}%.`);
  if (pos.thesis) lines.push(`Thesis on file: ${pos.thesis}`);
  if (pos.variantPerception) lines.push(`Variant perception: ${pos.variantPerception}`);
  const kvs = killVectorLines(pos.killVectors);
  if (kvs.length) lines.push('Kill vectors on file:', ...kvs.map((kv) => `- ${kv}`));
  return lines;
}

function buildPrompt(ticker, pos, quote) {
  const context = [];
  if (pos) context.push(...positionContext(pos));
  else context.push('This ticker is NOT currently held in the book.');
  if (typeof quote?.price === 'number') {
    const change = typeof quote.changePct === 'number' ? `, day change ${quote.changePct.toFixed(2)}%` : '';
    context.push(`Latest price on the desk tape: $${quote.price}${change}.`);
  } else {
    context.push('No fresh price on the desk tape for this ticker.');
  }
  const asked = String(process.env.QUESTION || '').trim().slice(0, 280);
  if (asked) context.push(`The requester specifically asks: ${asked}`);
  return [
    `You are the Young Bull research desk. Write a research brief on ${ticker}.`,
    '',
    context.join('\n'),
    '',
    'Format: markdown with these sections: What it is, The setup, Bull case, Bear case and kill vectors, Desk verdict.',
    `Start with the heading "# Research Brief: ${ticker}".`,
    'Voice: direct, punchy, peer to peer, like a sharp friend talking. Short sentences. No hype, no filler.',
    'Never use em dashes. Use commas and periods instead.',
    'Be honest about risk. If the setup is weak, say so plainly.',
    'DESCRIPTIVE ONLY, never prescriptive: no buy, sell, hold, trim, add, or position sizing instructions of any kind. The Desk verdict section describes what the data shows and what would change the picture. It never tells the reader what to do.',
    'Do not write "for internal use only" or similar. This is a public report.',
    'Keep it under 900 words.',
  ].join('\n');
}

async function callGroq(apiKey, prompt) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 1200,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content:
          'You are the research desk for Young Bull, a terminal style portfolio desk run by a young investor. Direct, honest, zero fluff. Never use em dashes.',
      },
      { role: 'user', content: prompt },
    ],
  });
  const attempt = () =>
    fetchWithTimeout(
      GROQ_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body,
      },
      GROQ_TIMEOUT_MS,
    );

  let res = await attempt();
  if (res.status === 429 || res.status >= 500) {
    console.error(`research-agent: Groq ${res.status}, retrying once in 10s`);
    await sleep(RETRY_DELAY_MS);
    res = await attempt();
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Groq API ${res.status}: ${truncate(detail, 300) || res.statusText}`);
  }
  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned an empty completion');
  return content;
}

async function main() {
  const { ticker, apiKey, issueNumber } = readEnv();
  const book = await readJson('book.json', { positions: [] });
  const prices = await readJson('prices.json', { quotes: {} });
  const pos = (book.positions ?? []).find((p) => String(p?.t || '').toUpperCase() === ticker);
  const quote = (prices.quotes ?? {})[ticker];

  const raw = await callGroq(apiKey, buildPrompt(ticker, pos, quote));
  const report = `${stripEmDashes(raw).trim()}\n\nGenerated by the yb-desk research agent. Not investment advice. Your money, your call.`;

  const date = todayISO();
  const file = `reports/research-${ticker}-${date}.md`;
  await writeTextBoth(file, `${report}\n`);
  const entry = { file, date, title: `Research Brief ${ticker} ${date}`, type: 'research', ticker };
  await updateReportsIndex(issueNumber === null ? entry : { ...entry, issue: issueNumber });
  await updateOffice(AGENT_ID, 'ok');

  console.log(report);
  console.error(`research-agent: wrote ${file}`);
}

main().catch((err) => fail(AGENT_ID, err.message));
