#!/usr/bin/env node
// examples/apify-promises.mjs — blindcheck pointed at REAL production gates.
//
// The subject is not a fixture: for each Actor we pull the dataset of its most recent SUCCEEDED
// run, which is the exact artifact a paying customer received. The gate is not a toy either: it is
// the `verify(items)` function from that Actor's own PROMISE.mjs, the thing that decides whether a
// build is allowed to be published.
//
//   node examples/apify-promises.mjs [--all] [--verbose]
//
// Requires APIFY_PERSONAL_TOKEN and the broketobuilt checkout beside this repo.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defineGate, audit, report } from '../src/index.js';

const ACTORS_DIR = process.env.ACTORS_DIR
  || path.join(os.homedir(), 'OneDrive/Desktop/Broke2BuiltHQ/broketobuilt/apify-actors');

// The money actors first — a blind gate on an earner is live revenue at risk, a blind gate on a
// zero-user actor is only a blocked opportunity.
const EARNERS = [
  'excel-to-json', 'pdf-text-extractor', 'audio-transcriber-whisper',
  'webpage-color-palette', 'webpage-images-extractor', 'webpage-text-extractor',
];

function token() {
  const f = path.join(os.homedir(), '.claude/secrets/apify-personal.env');
  const t = fs.readFileSync(f, 'utf8').match(/^APIFY_PERSONAL_TOKEN=(.+)$/m)?.[1]?.trim();
  if (!t) throw new Error('no APIFY_PERSONAL_TOKEN');
  return t;
}

// THE HEALTHY SUBJECT MUST BE THE GATE'S OWN SUBJECT.
//
// The first version of this file took "the most recent SUCCEEDED run" and reported three gates as
// broken. They were not: pdf-text-extractor's verify() expects three records from its own
// three-URL fixture, and the newest run was a one-URL customer-shaped run, so it correctly said
// "expected 3 records, got 1". I had fed a gate somebody else's artifact and then blamed the gate
// — which is `wrongSubject`, the mutation this very library calls the most important one.
//
// So: walk recent successful runs, read each run's INPUT, and take the first whose input MATCHES
// the PROMISE fixture. A run with different input is a different question.
function inputMatches(runInput, promiseInput) {
  if (!runInput || !promiseInput) return false;
  const norm = (v) => (Array.isArray(v) ? [...v].sort().join('|') : String(v ?? ''));
  // Compare only the fields the promise actually pins — extra run fields (defaults, limits) are fine.
  for (const [k, want] of Object.entries(promiseInput)) {
    if (want === '' || want == null) continue;              // unpinned in the fixture
    if (Array.isArray(want) && want.length === 0) continue;
    if (norm(runInput[k]) !== norm(want)) return false;
  }
  return true;
}

async function lastGoodDataset(slug, tok, promiseInput) {
  const runs = await fetch(`https://api.apify.com/v2/acts/eliai~${slug}/runs?status=SUCCEEDED&limit=25&desc=1&token=${tok}`).then((r) => r.json());
  for (const run of runs?.data?.items || []) {
    if (!run.defaultDatasetId || !run.defaultKeyValueStoreId) continue;
    let runInput = null;
    try {
      const res = await fetch(`https://api.apify.com/v2/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT?token=${tok}`);
      if (res.ok) runInput = await res.json();
    } catch { /* unreadable input — cannot claim this run is the gate's subject, so skip it */ }
    if (!inputMatches(runInput, promiseInput)) continue;

    const items = await fetch(`https://api.apify.com/v2/datasets/${run.defaultDatasetId}/items?token=${tok}&limit=50`).then((r) => r.json());
    if (Array.isArray(items) && items.length) return { items, runId: run.id, at: run.finishedAt };
  }
  return null;
}

const all = process.argv.includes('--all');
const verbose = process.argv.includes('--verbose');
const tok = token();

const slugs = all
  ? fs.readdirSync(ACTORS_DIR).filter((d) => fs.existsSync(path.join(ACTORS_DIR, d, 'PROMISE.mjs')))
  : EARNERS;

const gates = [];
const skipped = [];
for (const slug of slugs) {
  const pfile = path.join(ACTORS_DIR, slug, 'PROMISE.mjs');
  if (!fs.existsSync(pfile)) { skipped.push(`${slug}: no PROMISE.mjs`); continue; }
  let mod;
  try { mod = await import(`file://${pfile.replace(/\\/g, '/')}`); }
  catch (e) { skipped.push(`${slug}: PROMISE.mjs did not import — ${e.message.slice(0, 60)}`); continue; }
  if (typeof mod.verify !== 'function') { skipped.push(`${slug}: PROMISE.mjs exports no verify()`); continue; }

  const data = await lastGoodDataset(slug, tok, mod.input);
  if (!data) { skipped.push(`${slug}: no SUCCEEDED run whose INPUT matches PROMISE.input — cannot obtain this gate's own subject`); continue; }

  gates.push(defineGate({
    name: `${slug}  ${'\x1b[2m'}(run ${data.runId}, ${data.at?.slice(0, 10)})${'\x1b[0m'}`,
    subject: () => data.items,
    gate: (items) => mod.verify(items),
  }));
}

console.log(`\nblindcheck · ${gates.length} real production gates, each against the dataset a real buyer received\n`);
const result = await audit(gates);
console.log(report(result, { verbose }));
if (skipped.length) {
  console.log(`\n\x1b[2mskipped ${skipped.length}:\x1b[0m`);
  for (const s of skipped.slice(0, 12)) console.log(`  · ${s}`);
}
process.exitCode = result.verdict === 'ALL SIGHTED' ? 0 : 1;
