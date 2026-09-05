// engine.js — run a gate against the blindness library and score what it can see.
//
// THE CONTRACT
//   1. BASELINE. On a healthy subject the gate must PASS. If it fails here it is a false alarm and
//      everything after it is noise, so we stop grading that gate and say so.
//   2. MUTATIONS. For each applicable blindness mode we break the subject and require the gate to
//      FAIL. A gate that still passes is BLIND to that mode — it cannot tell good from bad, and
//      its green has never meant anything.
//   3. SELF-CHECK FIRST. Before grading anyone else, the harness grades two reference gates whose
//      answers are known: one that genuinely inspects its subject (must score SIGHTED) and one that
//      returns true unconditionally (must score BLIND on everything). If the harness cannot tell
//      those two apart it is broken, and it refuses to publish a verdict about your code.
//
// That last rule is the whole point and it is not decoration: this tool exists because we shipped
// seven "green" results in one day from scripts that could not see their subject.

import { mutations, subjectMutations, getMutation, isSubjectMutation, ALL } from './mutations.js';

export const VERDICT = { SIGHTED: 'SIGHTED', BLIND: 'BLIND', NA: 'N/A', FALSE_ALARM: 'FALSE_ALARM', ERROR: 'ERROR' };

export function defineGate(spec) {
  if (!spec?.name) throw new Error('defineGate: name is required');
  if (typeof spec.gate !== 'function') throw new Error(`defineGate(${spec.name}): gate must be a function`);
  if (typeof spec.subject !== 'function') throw new Error(`defineGate(${spec.name}): subject must be a function returning a healthy artifact`);
  return { mutations: ALL, ...spec };
}

/** A gate may return boolean, an array of failures (empty = pass), or {pass}. Anything else throws. */
function normalise(result, gateName) {
  if (typeof result === 'boolean') return result;
  if (Array.isArray(result)) return result.length === 0;
  if (result && typeof result === 'object' && 'pass' in result) return Boolean(result.pass);
  throw new Error(`gate "${gateName}" returned ${typeof result}; expected boolean, array of failures, or {pass}`);
}

async function runGate(gate, subject, name) {
  try {
    return { ok: normalise(await gate(subject), name), threw: false };
  } catch (e) {
    // A gate that throws on a broken subject has NOTICED. Throwing on a healthy one is a defect,
    // and the baseline step is what separates those two cases.
    return { ok: false, threw: true, error: String(e?.message || e).slice(0, 200) };
  }
}

export async function auditGate(spec) {
  const rows = [];
  let healthy;
  try {
    healthy = await spec.subject();
  } catch (e) {
    return { name: spec.name, verdict: VERDICT.ERROR, note: `subject() threw on the healthy path: ${e.message}`, rows: [], score: null };
  }

  const base = await runGate(spec.gate, healthy, spec.name);
  if (!base.ok) {
    return {
      name: spec.name,
      verdict: VERDICT.FALSE_ALARM,
      note: base.threw
        ? `gate threw on a HEALTHY subject: ${base.error}`
        : 'gate FAILED on a healthy subject — it cries wolf, so its reds mean nothing either',
      rows: [], score: null,
    };
  }

  for (const name of spec.mutations) {
    const m = getMutation(name);
    if (!m) { rows.push({ mutation: name, verdict: VERDICT.ERROR, note: 'unknown mutation' }); continue; }

    let broken;
    if (isSubjectMutation(name)) {
      if (name === 'unreachable') {
        // Special shape: the subject itself is what fails. The gate must not answer "fine".
        const r = await runGate(spec.gate, undefined, spec.name);
        rows.push({
          mutation: name, label: m.label, asks: m.asks, incident: m.incident,
          verdict: r.ok ? VERDICT.BLIND : VERDICT.SIGHTED,
          note: r.ok ? 'gate PASSED with no subject at all' : r.threw ? 'gate threw (noticed)' : 'gate failed (noticed)',
        });
        continue;
      }
      broken = m.apply(healthy);
    } else {
      broken = m.apply(healthy);
      if (broken === null) { rows.push({ mutation: name, label: m.label, verdict: VERDICT.NA, note: 'subject has nothing this mutation can break' }); continue; }

      // A MUTATION THAT DID NOT CHANGE THE SUBJECT CANNOT CONVICT ANYONE.
      // `truncate` on a one-element array, `duplicated` on a single record, `scaleDown` on a list
      // of one — each is a no-op, and scoring the gate BLIND for passing an UNBROKEN subject would
      // be exactly the false alarm this tool exists to shame. Found by running the tool on our own
      // Apify gates, where several datasets are a single record. (2026-09-05)
      try {
        if (JSON.stringify(broken) === JSON.stringify(healthy)) {
          rows.push({ mutation: name, label: m.label, verdict: VERDICT.NA, note: 'mutation was a no-op on this subject — nothing was actually broken' });
          continue;
        }
      } catch { /* unserialisable subject: fall through and grade it */ }
    }

    const r = await runGate(spec.gate, broken, spec.name);
    rows.push({
      mutation: name, label: m.label, asks: m.asks, incident: m.incident,
      verdict: r.ok ? VERDICT.BLIND : VERDICT.SIGHTED,
      note: r.ok ? 'gate PASSED a deliberately broken subject' : r.threw ? `gate threw (noticed): ${r.error}` : 'gate failed (noticed)',
    });
  }

  const applicable = rows.filter((r) => r.verdict === VERDICT.SIGHTED || r.verdict === VERDICT.BLIND);
  const sighted = rows.filter((r) => r.verdict === VERDICT.SIGHTED).length;
  const blind = rows.filter((r) => r.verdict === VERDICT.BLIND);
  return {
    name: spec.name,
    verdict: blind.length ? VERDICT.BLIND : applicable.length ? VERDICT.SIGHTED : VERDICT.NA,
    score: applicable.length ? { sighted, of: applicable.length } : null,
    blindTo: blind.map((b) => b.mutation),
    rows,
  };
}

// ── HARNESS SELF-CHECK ───────────────────────────────────────────────────────
// Two reference gates with known answers. A `sighted` gate that genuinely inspects its subject, and
// a `blind` gate that returns true no matter what. If we cannot separate those, we are the thing
// this tool was built to catch.
const REFERENCE_SUBJECT = () => ({
  status: 'SUCCEEDED',
  generatedAt: new Date().toISOString(),
  itemCount: 12,
  revenueUsd: 8.75,
  items: [{ id: 1, text: 'alpha beta gamma delta epsilon zeta' }, { id: 2, text: 'eta theta iota kappa lambda mu' },
          { id: 3, text: 'nu xi omicron pi rho sigma' }, { id: 4, text: 'tau upsilon phi chi psi omega' }],
});

const referenceSighted = {
  name: '__reference_sighted',
  subject: REFERENCE_SUBJECT,
  gate(s) {
    if (!s || typeof s !== 'object') return false;
    const fails = [];
    if (s.status !== 'SUCCEEDED') fails.push('status');
    if (!Array.isArray(s.items) || s.items.length !== 4) fails.push('item count changed');
    if (new Set(s.items.map((i) => i.text)).size !== s.items.length) fails.push('duplicate items');
    if (s.itemCount !== 12) fails.push('itemCount changed');
    if (!(s.revenueUsd > 0)) fails.push('revenue zeroed');
    if (Date.now() - Date.parse(s.generatedAt) > 86400000) fails.push('stale');
    for (const i of s.items) if (!i.text || i.text.length < 20) fails.push(`item ${i.id} truncated or empty`);
    if (s.items.some((i) => typeof i.id !== 'number')) fails.push('id shape');
    return fails;
  },
  mutations: ALL,
};

const referenceBlind = { name: '__reference_blind', subject: REFERENCE_SUBJECT, gate: () => true, mutations: ALL };

export async function selfCheck() {
  const problems = [];
  const s = await auditGate(referenceSighted);
  const b = await auditGate(referenceBlind);

  if (s.verdict === VERDICT.FALSE_ALARM) problems.push(`reference SIGHTED gate failed its own baseline: ${s.note}`);
  else if (s.verdict !== VERDICT.SIGHTED) problems.push(`reference SIGHTED gate scored ${s.verdict} (blind to: ${(s.blindTo || []).join(', ')}) — the harness under-reports blindness`);

  if (b.verdict !== VERDICT.BLIND) problems.push(`reference BLIND gate (returns true unconditionally) scored ${b.verdict} — THE HARNESS CANNOT DETECT BLINDNESS`);
  else if (b.score && b.score.sighted !== 0) problems.push(`reference BLIND gate scored ${b.score.sighted} sighted; expected 0`);

  const covered = b.rows.filter((r) => r.verdict !== VERDICT.NA).length;
  if (covered < 6) problems.push(`only ${covered} mutations were applicable to the reference subject — too few to certify the harness`);

  return { ok: problems.length === 0, problems, mutationsExercised: covered,
           referenceSighted: s.score, referenceBlind: b.score };
}

export async function audit(gates, { skipSelfCheck = false } = {}) {
  const self = skipSelfCheck ? { ok: true, skipped: true } : await selfCheck();
  if (!self.ok) return { harness: self, verdict: 'HARNESS_BLIND', gates: [] };

  const results = [];
  for (const g of gates) results.push(await auditGate(g));

  const blind = results.filter((r) => r.verdict === VERDICT.BLIND);
  const falseAlarm = results.filter((r) => r.verdict === VERDICT.FALSE_ALARM);
  return {
    harness: self,
    verdict: blind.length || falseAlarm.length ? 'DEFECTS' : 'ALL SIGHTED',
    counts: { total: results.length, blind: blind.length, falseAlarm: falseAlarm.length,
              sighted: results.filter((r) => r.verdict === VERDICT.SIGHTED).length },
    gates: results,
  };
}
