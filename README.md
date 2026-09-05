# blindcheck

**Prove your monitoring can see.**

Your agent has evals. Your pipeline has guardrails. Your workers have health checks. They are all
green.

Now answer the question none of them can: **would they still be green if the thing they watch were
broken?**

blindcheck answers it. It takes the artifact your check grades, breaks it in ways drawn from real
production incidents, and requires your check to notice. A check that stays green against a
deliberately broken subject is **BLIND** — and a blind check is worse than no check, because it
buys confidence you have not earned.

> A gate that cannot fail has never passed.

```bash
npm install blindcheck
```

```js
import { defineGate, audit, report } from 'blindcheck';

const gate = defineGate({
  name: 'transcript-completeness',
  subject: () => JSON.parse(fs.readFileSync('last-run.json', 'utf8')), // a HEALTHY artifact
  gate: (s) => s.segments.length > 0 && s.text.length > 0,             // your real check
});

console.log(report(await audit([gate])));
```

```
BLIND   transcript-completeness  4/7
         blind to truncate — truncated but well-formed
           asks: Does the gate check COMPLETENESS, or only shape?
```

That gate would have passed a transcript containing 29% of the audio. Ours did, for months, to
paying customers.

---

## This is not code mutation testing

Stryker, mutmut and PIT mutate your **source** and require your **unit tests** to fail. Excellent
tools, different target.

For monitoring, evals and guardrails the source is usually fine. What actually breaks is that
**the checker cannot see its subject** — it read the edited file instead of the deployed build, it
ran on the host instead of inside the container, its token returned empty and that scanned as
"nothing wrong", its fixture is a two-minute sample of a product sold on two-hour inputs.

So blindcheck mutates the **subject**, not the source.

## The mutations, and the incidents behind them

Every mutator here comes from a dated failure in a small AI company that runs itself — an
autonomous fleet of Cloudflare Workers, ~150 marketplace actors, and agent staff. Not a taxonomy
invented at a whiteboard. If a mutator has no incident behind it, it does not belong in the library.

| mutation | asks | the incident |
|---|---|---|
| `truncate` | Does it check COMPLETENESS, or only shape? | A transcriber returned **601s of a 2053s file**, `truncated:true`, status SUCCEEDED. Every file past one processing window came back cut — politely, free of charge, and green in every instrument we owned. |
| `empty` | Exit code, or product? | A venue's success counter read 37→37 failures while we shipped cut files. *The counter counts exit codes, not products.* |
| `zeroed` | Does it notice the number it exists to protect going to zero? | A memory limit made long jobs bill **$0 for nine days**. The revenue chart moved and was read as a market signal. It was downstream of a code path. |
| `shortenDenominator` | Does it assert HOW MANY things it checked? | A spec runner read its input on stdin, so the first check that read stdin ate the rest. It printed **"10 of 10, 100%"** while fifteen requirements were never read. |
| `stale` | Freshness, or any well-formed timestamp? | A hardcoded measurement window kept printing a number after it expired. A scheduler dropped six duties across a 9.5h outage with no log line. |
| `schemaValidLie` | Is there a DOMAIN gate, or only a schema check? | Shipped twice in one day: *"strict schema so it can't invent facts"*, and a system stamping recombined prices as "verified". A shape check proves output is well-formed, never that it is true. |
| `scaleDown` | Does it exercise the real failure mode and scale? | A promise gate ran a **two-minute** sample for an actor whose entire value is long audio. It never reached the second processing window, so it passed forever while the product was broken for every real buyer. |
| `duplicated` | Repetition, or only count? | A reply bot answered the same comment three times. Volume looked healthy. |
| `nulled` | Does it fail closed on absence? | A checker printed "earnings UNMEASURED" for the only venue with paying customers, and that read as acceptable rather than as an alarm. |
| `wrongSubject` | Is it reading its subject at all? | Checks ran on the host instead of inside the container, where the path does not exist — so **an absent file scored as a PASS**. Separately, an audit read the *edited* version while production served the *build*, declared "0 defects", and two revenue-earning services were still broken live. |
| `unreachable` | Does an unreadable subject produce UNKNOWN, or a green tick? | A `grep` with no file argument hung forever instead of erroring. A hang is not a throw. |

## It grades itself first

Before blindcheck says one word about your code, it grades two reference gates whose answers are
known: one that genuinely inspects its subject, and one that returns `true` unconditionally. If it
cannot tell those apart, it prints `HARNESS BLIND` and **publishes no verdict about you**, because
anything it said would be exactly the confident nonsense it exists to catch.

```
harness self-check: ok · 11 mutations exercised · reference sighted 11/11 · reference blind 0/11
```

## Two rules that keep it honest

Both were learned by pointing it at real gates and watching it convict innocent ones.

**A mutation that did not change the subject cannot convict anyone.** `truncate` on a one-element
array is a no-op. Scoring a gate BLIND for passing an *unbroken* subject is the false alarm this
tool exists to shame. No-ops score `N/A`.

**A mutation must look like a failure the system could actually emit.** The first `truncate` cut
`text` and `segments` while leaving `wordCount`, `transcribedSeconds` and `truncated` untouched — an
artifact no transcriber could ever produce — and scored a genuinely careful gate BLIND. Truncation
now drags companion counters down and flips completeness flags, exactly as a real short read does.
The result is the discrimination that matters: a gate checking `truncated !== true` is **SIGHTED**,
a gate checking `segments.length >= 1` is **BLIND**. Same mutation, opposite verdicts, both correct.

## A blind verdict is a question, not a conviction

The tool proposes; you adjudicate. Some blindness is a deliberate scope decision — a document
extractor *should* ignore how old the document is. Say so in code and move on:

```js
defineGate({ name: 'x', subject, gate, mutations: ['truncate', 'empty', 'wrongSubject'] })
```

What you should not do is leave a blind spot unexamined because the dashboard is green.

## What it found on us

We pointed it at **115 of our own production gates** — the `verify()` functions that decide whether
a marketplace actor may be published — with each healthy subject taken from a real run whose input
matches that gate's own fixture. These are not fixtures we wrote for the demo; they are the
artifacts real buyers received.

```
115 real production gates
53 sighted · 57 blind · 5 false-alarm

   35  blind to shortenDenominator
   19  blind to schemaValidLie
   17  blind to truncate
   17  blind to scaleDown
   14  blind to stale
    5  blind to duplicated
    4  blind to zeroed
```

**Roughly half of our publish gates could not tell a healthy result from a broken one**, and these
were written deliberately, by someone who cared, in a codebase that already had a rule saying every
check needs a control. Seventeen are blind to truncation — the failure that had *already* shipped
cut transcripts to paying customers. The lesson had been fixed in the code and never taught to the
gates. One of the seventeen is the dev twin of the very actor the incident came from.

Five more are `FALSE_ALARM`: they fail on healthy real data, so their reds mean nothing either.

The tool then earned its keep on the top earner. That gate asked `rowCount > 0` and
`rows.length < 1`, so a spreadsheet returning one of five thousand rows passed cleanly. Rewritten to
assert known counts instead of "more than zero": **3/7 BLIND → 7/7 SIGHTED**.

*Every number above was produced by the version in this repo, and two earlier versions of it were
thrown away for over-reporting — see the honesty rules.*

## API

- `defineGate({ name, subject, gate, mutations? })` — `subject()` returns a healthy artifact,
  `gate(subject)` returns `boolean` | `string[]` of failures | `{pass}`.
- `audit(gates)` → `{ harness, verdict, counts, gates }`
- `auditGate(gate)` → one result
- `selfCheck()` → can the harness detect blindness at all?
- `report(result, { verbose })` → human output
- `mutations`, `subjectMutations`, `ALL_MUTATIONS`

Verdicts: `SIGHTED` · `BLIND` · `N/A` · `FALSE_ALARM` (your gate fails a healthy subject, so its
reds mean nothing either) · `ERROR`.

## Licence

MIT.
