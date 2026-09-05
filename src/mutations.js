// mutations.js — the blindness library.
//
// Each mutator takes a HEALTHY subject (the artifact your gate grades when everything is fine)
// and returns a BROKEN one. Your gate is then required to notice. A gate that still passes is
// BLIND to that mutation — it cannot tell good from bad, so its green means nothing.
//
// This is the inverse of code mutation testing (Stryker, mutmut, PIT), which mutates SOURCE and
// requires unit tests to fail. For monitoring, evals and guardrails the source is usually fine —
// what breaks is that THE CHECKER CANNOT SEE ITS SUBJECT. So we mutate the subject.
//
// Every mutator below is derived from a dated production incident in an autonomously-operated AI
// company, not from a taxonomy someone invented at a whiteboard. The `incident` field is the
// receipt. If a mutator has no incident behind it, it does not belong here.

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Walk every value in a structure, applying fn(value, key, path) → replacement | KEEP. */
const KEEP = Symbol('keep');
function map(node, fn, path = []) {
  const replaced = fn(node, path[path.length - 1], path);
  if (replaced !== KEEP) return replaced;
  if (Array.isArray(node)) return node.map((v, i) => map(v, fn, [...path, i]));
  if (isObj(node)) {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = map(v, fn, [...path, k]);
    return out;
  }
  return node;
}

const MONEYISH = /(revenue|earn|paid|amount|price|balance|cost|usd|total|charge|payout)/i;
const COUNTISH = /(count|total|length|size|n|num|denominator|expected|required)/i;
const TIMEISH = /(at|time|date|updated|modified|generated|last|stamp|seen)/i;
// A date that is the ARTIFACT'S OWN generation time (freshness is the gate's business) versus a
// date that is CONTENT inside the artifact (a document's own metadata — legitimately ancient).
const GENERATED_AT = /^(generatedat|fetchedat|scrapedat|collectedat|retrievedat|updatedat|lastupdated|lastrun|runat|timestamp|asof|at|checkedat|observedat)$/i;
const DOC_META = /^(info|meta|metadata|exif|document|pdf|properties|headers)$/i;

export const mutations = {
  // ──────────────────────────────────────────────────────────────────────────
  truncate: {
    label: 'truncated but well-formed',
    asks: 'Does the gate check COMPLETENESS, or only shape?',
    incident:
      'audio-transcriber-whisper returned 601s of a 2053s file with status SUCCEEDED and ' +
      'truncated:true. Every file longer than one 600s window came back cut — politely, free of ' +
      'charge, and green in every instrument we owned. Our #3 earner, 31 users. (2026-09-03)',
    // COHERENCE. A mutation must look like a failure the system could actually EMIT, or it convicts
    // good gates. First version of this cut `text` and `segments` while leaving transcribedSeconds,
    // wordCount and truncated untouched — an artifact no transcriber could ever produce — and
    // scored audio-transcriber-whisper BLIND when its gate in fact opens with
    // `if (r.truncated === true)`. So truncation here also drags the companion counters down and
    // flips the completeness flags, exactly as a real short read does. (2026-09-05)
    apply(subject) {
      let cut = false;
      const RATIO = 1 / 3;
      const COUNTERS = /(count|seconds|length|size|words|chars|characters|rows|items|pages|total|duration|bytes)/i;
      const TRUNC_FLAG = /^(truncated|partial|cut|incomplete|clipped)$/i;
      const WHOLE_FLAG = /^(complete|completed|full|whole|finished)$/i;

      const shrinkObject = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (Array.isArray(v) && v.length > 1) { cut = true; out[k] = v.slice(0, Math.max(1, Math.floor(v.length * RATIO))).map(walk); }
          else if (typeof v === 'string' && v.length > 40) { cut = true; out[k] = v.slice(0, Math.floor(v.length * RATIO)); }
          else if (typeof v === 'number' && v > 1 && COUNTERS.test(k)) out[k] = Math.max(1, Math.floor(v * RATIO));
          else if (typeof v === 'boolean' && TRUNC_FLAG.test(k)) out[k] = true;
          else if (typeof v === 'boolean' && WHOLE_FLAG.test(k)) out[k] = false;
          else out[k] = walk(v);
        }
        return out;
      };
      const walk = (n) => (Array.isArray(n) ? n.map(walk) : isObj(n) ? shrinkObject(n) : n);

      let out = walk(subject);
      if (Array.isArray(subject) && subject.length > 1) { cut = true; out = out.slice(0, Math.max(1, Math.floor(subject.length * RATIO))); }
      return cut ? out : null; // null = not applicable to this subject
    },
  },

  empty: {
    label: 'succeeded, delivered nothing',
    asks: 'Does the gate distinguish an exit code from a product?',
    incident:
      'A venue success counter read fails30 37→37 while our actor was shipping cut files. ' +
      '"The counter counts exit codes, not products." Separately, an Actor could SUCCEED while ' +
      'producing an input-problem card instead of a result. (2026-08-16, 2026-09-03)',
    apply(subject) {
      let touched = false;
      const out = map(subject, (v, k) => {
        if (Array.isArray(v) && v.length > 0) { touched = true; return []; }
        if (typeof v === 'string' && v.length > 0 && !ISO.test(v) && !/status|state|ok/i.test(String(k))) {
          touched = true; return '';
        }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  zeroed: {
    label: 'money and metrics silently zero',
    asks: 'Does the gate notice when the number it exists to protect goes to zero?',
    incident:
      'An RLIMIT_AS cap made long transcriptions bill $0 for nine days. The revenue chart moved ' +
      'and was read as a market signal; it was downstream of a code path. (2026-08-27 → 2026-09-04)',
    apply(subject) {
      let touched = false;
      const out = map(subject, (v, k) => {
        if (typeof v === 'number' && v !== 0 && MONEYISH.test(String(k))) { touched = true; return 0; }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  shortenDenominator: {
    label: 'fewer things graded, ratio still looks fine',
    asks: 'Does the gate assert HOW MANY things it checked, not just the pass rate?',
    incident:
      'A spec runner read its input on stdin, so the first check that read stdin ate the rest. ' +
      'It printed "10 of 10, 100%" while fifteen requirements were never read. A measurement that ' +
      'silently shortens its own denominator is worse than none. (2026-09-03)',
    apply(subject) {
      let touched = false;
      const out = map(subject, (v, k) => {
        if (typeof v === 'number' && v > 1 && COUNTISH.test(String(k))) { touched = true; return Math.max(1, Math.floor(v / 4)); }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  stale: {
    label: 'everything frozen in the past',
    asks: 'Does the gate check FRESHNESS, or accept any well-formed timestamp?',
    incident:
      'A hardcoded run-rate window kept printing a number after the window expired. A scheduler ' +
      'dropped six duties across a 9.5h outage with no log line. A cheaper RSS pass that could not ' +
      'read privacyStatus stood down the credentialed check that could. (2026-08-20, 2026-09-03)',
    apply(subject) {
      let touched = false;
      const old = new Date(Date.now() - 400 * 86400000).toISOString();
      const out = map(subject, (v, k, p) => {
        // Only the artifact's OWN generation time counts. A date that is CONTENT — a 1944 letter's
        // creationDate, a document's exif, a scraped article's publish date — is legitimately old,
        // and flagging a gate for "not noticing" it would be a false alarm. Found the honest way:
        // this mutator convicted pdf-text-extractor over a National Archives PDF from 1944.
        if (DOC_META.test(String(p[p.length - 2] ?? ''))) return KEEP;
        if (!GENERATED_AT.test(String(k))) return KEEP;
        if (typeof v === 'string' && ISO.test(v)) { touched = true; return old; }
        if (typeof v === 'number' && v > 1e12) { touched = true; return Date.now() - 400 * 86400000; }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  schemaValidLie: {
    label: 'perfect shape, wrong values',
    asks: 'Is there a DOMAIN gate, or only a schema check?',
    incident:
      'We shipped that confusion twice in one day — "strict schema so it cannot invent facts", and ' +
      'a site brain stamping recombined prices as "verified". A shape check proves an output is ' +
      'WELL-FORMED, never that it is TRUE. (2026-07-27, the two-gates law)',
    apply(subject) {
      let touched = false;
      const out = map(subject, (v, k) => {
        if (typeof v === 'number' && !TIMEISH.test(String(k))) { touched = true; return v === 0 ? 7 : Math.round(v * 3.7 + 13); }
        if (typeof v === 'string' && v.length > 3 && !ISO.test(v)) { touched = true; return v.split('').reverse().join(''); }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  scaleDown: {
    label: 'tested at a size the product is not sold at',
    asks: 'Does the gate exercise the REAL failure mode and scale?',
    incident:
      'PROMISE.mjs ran a 2-minute Gettysburg prefill — which never reaches a second processing ' +
      'window — for an actor whose entire value is long audio. The gate passed forever while the ' +
      'product was broken for every real buyer. (2026-09-03)',
    apply(subject) {
      let touched = false;
      const out = map(subject, (v) => {
        if (Array.isArray(v) && v.length > 1) { touched = true; return v.slice(0, 1); }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  duplicated: {
    label: 'the same item, over and over',
    asks: 'Does the gate notice repetition, or only count?',
    incident:
      'The comment firewall replied 2-3 times to the SAME comment (@AceRobo three times) and no ' +
      'instrument flagged it; volume looked healthy. (2026-09-05)',
    apply(subject) {
      let touched = false;
      const out = map(subject, (v) => {
        if (Array.isArray(v) && v.length > 0) { touched = true; return Array(v.length).fill(v[0]); }
        return KEEP;
      });
      return touched ? out : null;
    },
  },

  nulled: {
    label: 'required fields missing',
    asks: 'Does the gate fail closed on absence, or treat missing as fine?',
    incident:
      'A private copy of a secrets loader was file-only with no env fallback, so on the box it ' +
      'printed "earnings UNMEASURED" for the only venue with paying strangers — and that read as ' +
      'acceptable rather than as an alarm. (2026-09-04)',
    apply(subject) {
      if (!isObj(subject) && !Array.isArray(subject)) return null;
      let touched = false;
      const out = map(subject, (v, k, p) => {
        if (p.length === 1 && v !== null && typeof v !== 'object') { touched = true; return null; }
        return KEEP;
      });
      return touched ? out : null;
    },
  },
};

// ── SUBJECT-LEVEL MUTATIONS ──────────────────────────────────────────────────
// These do not corrupt the value; they change WHAT THE GATE IS LOOKING AT. They are the most
// important family, because the commonest real failure is not a wrong answer — it is a gate
// grading something other than the thing it believes it is grading.
export const subjectMutations = {
  wrongSubject: {
    label: 'handed a different artifact entirely',
    asks: 'Is the gate actually reading its subject, or passing on autopilot?',
    incident:
      'Checks ran on the WSL host instead of inside the container, where /company does not exist — ' +
      'so an ABSENT FILE SCORED AS A PASS. Separately, an audit read the edited version of an ' +
      'Actor while production served the build, declared "0 defects", and two revenue-earning ' +
      'actors were still rejecting {} live. A checker pointed at your own edit will always ' +
      'congratulate you. (2026-09-02, 2026-08-16)',
    apply: () => ({ blindcheck: 'this is not your subject', unrelated: [1, 2, 3], nothing: 'here' }),
  },

  unreachable: {
    label: 'the subject cannot be read at all',
    asks: 'Does an unreadable subject produce UNKNOWN, or a green tick?',
    incident:
      'A grep with no file argument hung forever rather than erroring. A hang is not a throw: one ' +
      'actor flagged UNDER_MAINTENANCE showed 0% listing because the failure never raised. ' +
      '(2026-08-22, 2026-09-02)',
    apply: () => { throw new Error('blindcheck: subject deliberately unreachable'); },
  },
};

export const ALL = [...Object.keys(mutations), ...Object.keys(subjectMutations)];

export function getMutation(name) {
  return mutations[name] || subjectMutations[name] || null;
}
export function isSubjectMutation(name) {
  return Boolean(subjectMutations[name]);
}
