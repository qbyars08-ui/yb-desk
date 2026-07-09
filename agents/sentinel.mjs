#!/usr/bin/env node
// sentinel: the agent that keeps every other agent honest.
//
// Runs hourly. Checks the age of every data artifact against its expected
// cadence (market-hours aware), and when something is stale it re-dispatches
// the workflow that produces it via the GitHub API. If a re-dispatch does not
// heal the artifact after repeated attempts, it opens ONE deduped GitHub
// issue so Quinn gets a native notification, and otherwise never bothers a
// human. Writes health.json (both copies) so the site can render its own
// receipts. This is what "the desk checks itself" means.
//
// Locally (no GITHUB_TOKEN): dry-run, report only.
// Run: node agents/sentinel.mjs

import {
  fail,
  nowISO,
  readJson,
  updateOffice,
  writeJsonBoth,
} from './lib.mjs';

const AGENT_ID = 'sentinel';
const REPO = process.env.GITHUB_REPOSITORY || 'qbyars08-ui/yb-desk';
const TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const REDISPATCH_COOLDOWN_MIN = 100; // don't re-kick the same workflow within ~1.5h
const ESCALATE_AFTER_ATTEMPTS = 3;   // failed heals before we open an issue

// What must stay fresh, who produces it, and how old it may be.
// weekendMax covers Fri-close -> Mon-open plus slack.
const CHECKS = [
  { id: 'tape',    file: 'prices.json',        field: 'updated',      workflow: 'prices.yml',      weekdayMaxH: 3.5, weekendMaxH: 76, marketHoursOnly: true },
  { id: 'book',    file: 'book.json',          field: 'generated_at', workflow: 'desk-report.yml', weekdayMaxH: 30,  weekendMaxH: 80 },
  { id: 'signals', file: 'signals.json',       field: 'updated',      workflow: 'signals.yml',     weekdayMaxH: 30,  weekendMaxH: 80 },
  { id: 'reports', file: 'reports-index.json', field: 'updated',      workflow: 'desk-report.yml', weekdayMaxH: 30,  weekendMaxH: 80 },
  { id: 'scan',    file: 'scan.json',          field: 'updated',      workflow: 'signals.yml',     weekdayMaxH: 30,  weekendMaxH: 80 },
  { id: 'proving', file: 'backtests.json',     field: 'updated',      workflow: 'signals.yml',     weekdayMaxH: 30,  weekendMaxH: 80 },
];

function isMarketHoursUTC(d) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= 13 * 60 + 30 && mins <= 21 * 60 + 30; // 13:30-21:30 UTC
}

function isWeekendWindow(d) {
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return true;
  // Monday before the tape's first market-hours run counts as weekend slack.
  return day === 1 && d.getUTCHours() < 15;
}

async function gh(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
}

async function dispatchWorkflow(workflowFile) {
  const res = await gh(`/repos/${REPO}/actions/workflows/${workflowFile}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref: 'main' }),
  });
  return res.status === 204;
}

async function openIssueOnce(title, body) {
  // Dedup: one open sentinel issue at a time.
  const list = await gh(`/repos/${REPO}/issues?labels=sentinel&state=open&per_page=1`);
  if (list.ok) {
    const issues = await list.json().catch(() => []);
    if (Array.isArray(issues) && issues.length) return 'already_open';
  }
  const res = await gh(`/repos/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title, body, labels: ['sentinel'] }),
  });
  return res.ok ? 'opened' : 'open_failed';
}

async function main() {
  const now = new Date();
  const prev = await readJson('health.json', { dispatches: {}, attempts: {} });
  const dispatches = { ...(prev.dispatches || {}) };
  const attempts = { ...(prev.attempts || {}) };
  const weekend = isWeekendWindow(now);
  const marketOpen = isMarketHoursUTC(now);
  const dryRun = !TOKEN;

  const checks = [];
  const escalations = [];

  for (const c of CHECKS) {
    const doc = await readJson(c.file, null);
    const stampRaw = doc && doc[c.field];
    const stamp = stampRaw ? new Date(stampRaw).getTime() : NaN;
    const ageMin = Number.isFinite(stamp) ? Math.round((now.getTime() - stamp) / 60000) : null;
    const maxH = weekend ? c.weekendMaxH : c.weekdayMaxH;
    // marketHoursOnly artifacts are only held to the tight bound while the
    // market is open; overnight they get the weekend-grade allowance.
    const effectiveMaxH = c.marketHoursOnly && !marketOpen && !weekend
      ? Math.max(c.weekdayMaxH, 20)
      : maxH;
    const maxMin = Math.round(effectiveMaxH * 60);
    const fresh = ageMin !== null && ageMin <= maxMin;

    let action = 'none';
    if (!fresh) {
      const lastKick = dispatches[c.workflow] ? new Date(dispatches[c.workflow]).getTime() : 0;
      const sinceKickMin = (now.getTime() - lastKick) / 60000;
      const tries = attempts[c.workflow] || 0;
      if (tries >= ESCALATE_AFTER_ATTEMPTS) {
        action = 'escalated';
        escalations.push(`${c.id} (${c.file}) is ${ageMin === null ? 'unreadable' : ageMin + ' min old'}, limit ${maxMin} min, after ${tries} heal attempts on ${c.workflow}`);
      } else if (sinceKickMin < REDISPATCH_COOLDOWN_MIN) {
        action = 'waiting_on_dispatch';
      } else if (dryRun) {
        action = 'would_dispatch';
      } else {
        const ok = await dispatchWorkflow(c.workflow);
        action = ok ? 'dispatched' : 'dispatch_failed';
        if (ok) {
          dispatches[c.workflow] = nowISO();
          attempts[c.workflow] = tries + 1;
        }
      }
    } else {
      // Healthy again: clear the strike counter for its producer.
      attempts[c.workflow] = 0;
    }

    checks.push({
      id: c.id,
      file: c.file,
      ageMinutes: ageMin,
      maxAgeMinutes: maxMin,
      fresh,
      workflow: c.workflow,
      action,
    });
  }

  let issue = null;
  if (escalations.length && !dryRun) {
    issue = await openIssueOnce(
      'sentinel: an agent needs a human',
      'The sentinel re-dispatched these producers repeatedly and the data is still stale:\n\n' +
        escalations.map((e) => `- ${e}`).join('\n') +
        '\n\nCheck the Actions tab for the failing workflow runs. The sentinel keeps running and will close the loop once data is fresh again.',
    );
  }

  // Money queue: paying subscribers waiting for desk access. One deduped
  // issue (label: members) so Quinn gets a native notification, no checking.
  let memberIssue = null;
  const cronToken = process.env.CRON_ALERTS_TOKEN || '';
  if (!dryRun && cronToken) {
    try {
      const r = await fetch('https://youngbullinvests.com/api/member-request', {
        headers: { 'x-cron-token': cronToken },
      });
      const j = r.ok ? await r.json().catch(() => null) : null;
      const pending = j && Array.isArray(j.pending) ? j.pending : [];
      if (pending.length) {
        const list = await gh(`/repos/${REPO}/issues?labels=members&state=open&per_page=1`);
        const already = list.ok ? await list.json().catch(() => []) : [];
        if (!Array.isArray(already) || !already.length) {
          const res = await gh(`/repos/${REPO}/issues`, {
            method: 'POST',
            body: JSON.stringify({
              title: `members: ${pending.length} pending activation${pending.length === 1 ? '' : 's'}`,
              body: 'These signed-in readers say they subscribed on the Substack and are waiting for desk access:\n\n' +
                pending.map((p) => `- ${p.email} (asked ${p.requested_at})`).join('\n') +
                '\n\nVerify each against the Substack subscriber list, then activate with:\n' +
                '`INSERT INTO premium_members (email, status, synced_at) VALUES (\'their@email\', \'active\', now()) ON CONFLICT DO NOTHING;`\n' +
                'and mark the queue row `UPDATE pending_members SET status=\'activated\' WHERE email=\'their@email\';`\n' +
                'Or tell the next desk session to "activate the pending members" and it handles it.',
              labels: ['members'],
            }),
          });
          memberIssue = res.ok ? 'opened' : 'open_failed';
        } else {
          memberIssue = 'already_open';
        }
      }
    } catch { /* queue check is best-effort, never blocks health */ }
  }

  const ok = checks.every((c) => c.fresh);
  await writeJsonBoth('health.json', {
    updated: nowISO(),
    ok,
    marketOpen,
    weekendWindow: weekend,
    dryRun,
    checks,
    dispatches,
    attempts,
    issue,
    memberIssue,
  });
  await updateOffice(AGENT_ID, ok ? 'ok' : 'healing');
  console.log(
    `sentinel: ${checks.filter((c) => c.fresh).length}/${checks.length} fresh` +
      checks.filter((c) => !c.fresh).map((c) => ` | ${c.id} ${c.action}`).join('') +
      (issue ? ` | issue:${issue}` : ''),
  );
}

main().catch((err) => fail(AGENT_ID, err.message));
