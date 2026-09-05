// blindcheck — prove your gate can see.
//
//   import { defineGate, audit, report } from 'blindcheck';
//
// Point it at the checks you already have. It breaks the thing they grade, in ways drawn from real
// production incidents, and requires them to notice. A check that stays green against a deliberately
// broken subject is BLIND — and a blind check is worse than no check, because it buys confidence.

export { defineGate, audit, auditGate, selfCheck, VERDICT } from './engine.js';
export { mutations, subjectMutations, getMutation, ALL as ALL_MUTATIONS } from './mutations.js';

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', o: '\x1b[0m' };

const mark = (v) => ({
  SIGHTED: `${C.g}SIGHTED${C.o}`,
  BLIND: `${C.r}BLIND  ${C.o}`,
  'N/A': `${C.d}n/a    ${C.o}`,
  FALSE_ALARM: `${C.y}FALSE  ${C.o}`,
  ERROR: `${C.y}ERROR  ${C.o}`,
}[v] || v);

/** Human report. Pass {verbose:true} to print the incident behind every blind spot. */
export function report(result, { verbose = false, color = true } = {}) {
  const p = color ? (s) => s : (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const L = [];
  const say = (s = '') => L.push(p(s));

  if (result.verdict === 'HARNESS_BLIND') {
    say(`${C.r}${C.b}HARNESS BLIND — no verdict published about your gates.${C.o}`);
    for (const pr of result.harness.problems) say(`  · ${pr}`);
    say('');
    say('blindcheck grades two reference gates before it grades yours: one that genuinely');
    say('inspects its subject, and one that returns true no matter what. It could not tell');
    say('them apart, so anything it said about your code would be exactly the kind of');
    say('confident nonsense it exists to catch.');
    return L.join('\n');
  }

  if (!result.harness.skipped) {
    say(`${C.d}harness self-check: ok · ${result.harness.mutationsExercised} mutations exercised · ` +
        `reference sighted ${result.harness.referenceSighted?.sighted}/${result.harness.referenceSighted?.of} · ` +
        `reference blind 0/${result.harness.referenceBlind?.of}${C.o}`);
  }
  say('');

  for (const g of result.gates) {
    const score = g.score ? `${g.score.sighted}/${g.score.of}` : '—';
    say(`${mark(g.verdict)} ${C.b}${g.name}${C.o}  ${score}`);
    if (g.note) say(`         ${C.y}${g.note}${C.o}`);
    for (const r of g.rows) {
      if (r.verdict === 'BLIND') {
        say(`         ${C.r}blind to${C.o} ${C.b}${r.mutation}${C.o} — ${r.label}`);
        say(`           ${C.d}asks: ${r.asks}${C.o}`);
        if (verbose && r.incident) say(`           ${C.d}incident: ${r.incident.replace(/\s+/g, ' ')}${C.o}`);
      } else if (verbose && r.verdict === 'SIGHTED') {
        say(`         ${C.g}catches${C.o} ${r.mutation}`);
      }
    }
    say('');
  }

  const c = result.counts;
  say(`${C.b}${c.sighted} sighted · ${c.blind} blind · ${c.falseAlarm} false-alarm  (of ${c.total})${C.o}`);
  if (c.blind) {
    say('');
    say(`${C.r}A gate that cannot fail has never passed.${C.o} Each blind spot above is a class of`);
    say('breakage this check would report as healthy, forever, in production.');
  }
  return L.join('\n');
}
