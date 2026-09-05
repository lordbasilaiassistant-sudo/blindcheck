#!/usr/bin/env node
// selftest.mjs — blindcheck must survive its own thesis.
//
// A tool that shames blind gates has no business shipping a blind test suite, so every case here is
// a real defect this code had during its first hour of life, on 2026-09-05, found by pointing it at
// production gates instead of at fixtures.

import { defineGate, auditGate, selfCheck, VERDICT } from '../src/index.js';
import { mutations } from '../src/mutations.js';

let failed = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => { console.log(`  FAIL  ${m}`); failed++; };
const eq = (got, want, m) => (got === want ? ok(`${m}`) : bad(`${m} — got ${got}, wanted ${want}`));

console.log('\n1. HARNESS SELF-CHECK (can it tell a real gate from a rubber stamp?)');
{
  const s = await selfCheck();
  s.ok ? ok('self-check passes') : bad(`self-check: ${s.problems.join(' | ')}`);
  eq(s.referenceBlind?.sighted, 0, 'a gate returning true always scores 0 sighted');
  eq(s.referenceSighted?.sighted, s.referenceSighted?.of, 'a gate that truly inspects catches everything');
}

console.log('\n2. FALSE ALARM (a gate that fails a healthy subject is not "strict", it is broken)');
{
  const r = await auditGate(defineGate({ name: 'x', subject: () => ({ a: [1, 2, 3] }), gate: () => false }));
  eq(r.verdict, VERDICT.FALSE_ALARM, 'gate failing its baseline is FALSE_ALARM, not BLIND');
}

console.log('\n3. NO-OP MUTATIONS MUST NOT CONVICT  (regression: single-record datasets)');
{
  // truncate/scaleDown/duplicated on a one-element array change nothing. Scoring the gate BLIND for
  // passing an UNBROKEN subject is the exact false alarm this tool exists to shame.
  const r = await auditGate(defineGate({
    name: 'single-item',
    subject: () => [{ id: 1 }],
    gate: (s) => Array.isArray(s) && s.length === 1 && s[0]?.id === 1,
    mutations: ['scaleDown', 'duplicated'],
  }));
  const verdicts = r.rows.map((x) => x.verdict);
  verdicts.every((v) => v === VERDICT.NA)
    ? ok('no-op mutations score N/A, not BLIND')
    : bad(`expected all N/A, got ${JSON.stringify(r.rows.map((x) => [x.mutation, x.verdict]))}`);
}

console.log('\n4. COHERENCE  (regression: a mutation must look like a failure the system could emit)');
{
  // The first truncate cut text/segments while leaving transcribedSeconds, wordCount and truncated
  // untouched — impossible output — and scored a genuinely sighted transcriber gate BLIND.
  const healthy = () => ({
    ok: true, truncated: false, durationSeconds: 2053, transcribedSeconds: 2053, wordCount: 3400,
    segments: Array.from({ length: 60 }, (_, i) => ({ i, t: `segment number ${i} with real words in it` })),
    text: 'four score and seven years ago our fathers brought forth on this continent a new nation'.repeat(4),
  });
  const broken = mutations.truncate.apply(healthy());
  broken.truncated === true ? ok('truncate flips the truncated flag') : bad('truncate left truncated=false — incoherent');
  broken.transcribedSeconds < 2053 ? ok('truncate drags companion counters down') : bad('transcribedSeconds unchanged — incoherent');
  broken.wordCount < 3400 ? ok('truncate lowers wordCount') : bad('wordCount unchanged — incoherent');

  // A gate that checks completeness must now CATCH it...
  const completeness = await auditGate(defineGate({
    name: 'checks-completeness', subject: healthy, mutations: ['truncate'],
    gate: (r) => r.truncated !== true && r.transcribedSeconds >= r.durationSeconds * 0.98,
  }));
  eq(completeness.rows[0].verdict, VERDICT.SIGHTED, 'a completeness check catches coherent truncation');

  // ...and a gate that only checks non-emptiness must still be caught out.
  const nonEmpty = await auditGate(defineGate({
    name: 'checks-non-empty', subject: healthy, mutations: ['truncate'],
    gate: (r) => Array.isArray(r.segments) && r.segments.length >= 1 && typeof r.text === 'string' && r.text.length > 0,
  }));
  eq(nonEmpty.rows[0].verdict, VERDICT.BLIND, 'a non-emptiness check is still blind to truncation');
}

console.log('\n5. CONTENT DATES ARE NOT STALENESS  (regression: a 1944 PDF is legitimately old)');
{
  const r = await auditGate(defineGate({
    name: 'doc-with-old-metadata',
    subject: () => ({ generatedAt: new Date().toISOString(), info: { createdAt: '1944-06-06T00:00:00.000Z' }, items: [1, 2, 3] }),
    gate: (s) => Date.now() - Date.parse(s.generatedAt) < 86400000,
    mutations: ['stale'],
  }));
  eq(r.rows[0].verdict, VERDICT.SIGHTED, 'stale targets generation time, not document metadata');
}

console.log('\n6. THE SUBJECT-LEVEL MUTATIONS  (the commonest real failure)');
{
  const autopilot = await auditGate(defineGate({
    name: 'autopilot', subject: () => ({ items: [1, 2, 3] }), gate: () => true,
    mutations: ['wrongSubject', 'unreachable'],
  }));
  autopilot.rows.every((x) => x.verdict === VERDICT.BLIND)
    ? ok('a gate ignoring its subject is blind to wrongSubject AND unreachable')
    : bad(`expected both BLIND, got ${JSON.stringify(autopilot.rows.map((x) => [x.mutation, x.verdict]))}`);

  const careful = await auditGate(defineGate({
    name: 'careful', subject: () => ({ items: [1, 2, 3] }),
    gate: (s) => Array.isArray(s?.items) && s.items.length === 3,
    mutations: ['wrongSubject', 'unreachable'],
  }));
  careful.rows.every((x) => x.verdict === VERDICT.SIGHTED)
    ? ok('a gate that reads its subject catches both')
    : bad(`expected both SIGHTED, got ${JSON.stringify(careful.rows.map((x) => [x.mutation, x.verdict]))}`);
}

console.log('\n7. EVERY MUTATOR CARRIES A RECEIPT');
{
  const missing = Object.entries(mutations).filter(([, m]) => !m.incident || m.incident.length < 40).map(([k]) => k);
  missing.length === 0 ? ok('every mutator cites a dated incident') : bad(`no incident on: ${missing.join(', ')}`);
}

console.log(`\n${failed ? `${failed} FAILURE(S)` : 'ALL GREEN'}`);
process.exitCode = failed ? 1 : 0;
