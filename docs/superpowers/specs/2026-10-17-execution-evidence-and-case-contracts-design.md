# Execution Evidence and Case Contracts — Design

Status: **written, not executed.** Implementation begins only on explicit go-ahead, on a fresh feature
branch; this branch stays docs-only. Authored 2026-10-17 from the open-findings re-check (§6).
Optimization axes are long-term benefit, safety, and performance only — **no backward-compatibility
constraints apply**: manifests and rosters may grow required fields and refuse old shapes.

## 1. Findings and decision boundary

Input: nine open findings (2026-10-12/13 campaign findings, the descendant-env discrepancy, and the
lingering-descendant flake), re-checked 2026-10-17 against main `490b3e5` by one authorized
`gpt-6-astra`/`high` review (§6). Adjudication after source spot-checks:

| # | Finding | Adjudication | Disposition |
| --- | --- | --- | --- |
| F1 | Hosted Jev answers HTTP 451 on every observed path | Refusal on the hosted path; regional/legal/account/intermediary indistinguishable — causation unresolved by available evidence. Transport already fails closed retaining the status (`src/systemone.ts:180`); doctor collapses it to "failed" (`src/doctor.ts:75`) | **AF-1** (bounded doctor fix); hosted availability stays unresolved |
| F2 | Strict stdout oracle failed on a completed astra run | Output nonconformance established; model error vs contamination vs framing unrankable — why, unresolved. Main's boundary/schema/framing reduce the opportunity class but do not demonstrate conformance; neither harness passes `--output-schema` today | **SC-1** |
| F3 | Six-profile natural coverage gap (roster stopped at case 4) | Old stop protocol defect already resolved (oracle-only failures continue, exit 4). Admission cases rebind profile mappings (`test/live-acceptance.ts:730`), so admission can never evidence natural coverage | **Evidence rule §3.7** + fresh campaign work; no product change |
| F4 | Worker non-completion / 143 / one 240 s timeout | Completed/143/`ownedShutdown` is by-design settlement, not failure; deep cause of the historical timeout and failed 143s unresolved (single re-run passed in 52 s). Receipt fields cannot attribute stalls; raw stderr deliberately discarded | **EV-1** (bounded lifecycle evidence) |
| F5 | Oracle root rebinding (roster harness defect) | Consumer-root identity gates exist (dev/ino, pre-spend and settled-tree); the declarative stdout grader has no root to rebind. But roster-referenced **contract/oracle files load by path** (`test/custom-round.ts:560,1161`) outside the consumer root — identity binding for an external oracle root is unproved | **OR-1** (P1) |
| F6 | Routing-band mismatches (language-dependent) | Criteria/bands/classifier attribution unresolved; band policy vs natural-task fit needs discriminating multilingual evidence. Current criteria are fixed strings (`src/systemone.ts:266`) | **Deferred** with an explicit gate (§5) |
| F7 | Fixed 240 s outer deadline stopped an approved round | Custom-round already continues past unjudged timeouts; production deadline is a fixed constant whose override is a test knob; standard acceptance still stops the round | **DL-1** |
| F8 | Descendant-env / managed-marker discrepancy | Shell-startup re-import is the best-supported mechanism class (targeted zsh regression exists); the historical descendant's identity and key set stay unresolved. Current tests do not jointly establish key set + marker in one identified surviving descendant | **AF-2** (bounded sentinel test; claim stays mechanism-level) |
| F9 | `cleanup-unverified` flake under load | Concrete race: fixed 700 ms abort vs descendant creation with no readiness acknowledgement, plus a 4 s self-exit window (`test/live-acceptance.test.ts:833,2263`). Product stop-reason ordering is correct | **AF-3** (fixture synchronization only) |

Decision boundary: a reasonable user gets case contracts whose inputs, oracles, and deadlines are
identity-frozen and spend-bounded; bounded content-free evidence that attributes or honestly fails to
attribute worker non-completion; machine-output cases that ask codex itself to enforce their schemas;
and diagnostics that say what was observed (HTTP 451) without inventing why.

## 2. Scope, inheritance, and invariants

Inherited unchanged: the worker instruction boundary (managed home, credential gate,
`codexHomeManaged`), terminal-event settlement semantics and the stop ladder, framing-only payload
classification, frozen failure taxonomy, single-use manifests with SHA-gated claims, evidence-ledger
discipline and its bounded projections, custom-round exit semantics, env stripping and `ZDOTDIR`
redirect. Nothing in this spec weakens an existing gate to make a test pass.

Touch surface: `src/codex.ts` (lifecycle record), `src/cli.ts` (receipt projection), `src/doctor.ts`
(probe outcome), `test/custom-round.ts`, `test/live-acceptance.ts`, `test/live-acceptance.test.ts`,
`test/custom-round.test.ts`, `test/worker.test.ts`, plus docs. Routing, classifier request building,
transport, and config parsing are untouched.

## 3. Design

### 3.1 SC-1 — Per-case output schema contract (F2)

Machine-output cases in both harnesses may freeze an explicit JSON Schema with their manifest
(prepare-time validation: 64 KiB, strict UTF-8, single JSON object — same bounds as the CLI), and the
harness passes it through the existing product interface (`run --output-schema <file>` → staged bytes
inside the managed home). The worker's final message is then enforced by codex itself; the case's
exact oracle still judges content. Framing-only `payload.mode` classification is unchanged. Old
manifests without the optional field keep their current behavior; a manifest that names a schema the
CLI rejects fails at prepare with fixed wording, before any spend.

### 3.2 EV-1 — Bounded worker lifecycle evidence (F4)

The product gains an opt-in, bounded, **content-free** lifecycle record for the worker child:
relative timestamps; owned PID and validated native thread correlation where the event stream
provides one; allowlisted event categories (no raw text); `completion-seen`; exit/EOF/close
milestones; observed error class from the frozen taxonomy; shutdown actions taken. Capacity is
bounded with terminal milestones preserved when the capacity exhausts (an overflow marker, never
truncation of the tail). Observations are persisted as they occur — available **before** final
settlement — so an outer kill cannot erase them. The record rides the receipt as a bounded
projection, degraded (not fabricated) when fields are absent. The standard acceptance harness
retains the timeline for failed *and* timed-out workers and supports cross-run comparison. What
attribution the record cannot establish stays explicitly unattributed.

### 3.3 OR-1 — Oracle and fixture identity binding (F5, P1)

Eliminate oracle root rediscovery: the case binding (expected values, oracle inputs) is supplied
explicitly by the frozen manifest. Where a genuinely separate oracle/fixture root is required, its
identity (dev/ino of the root, plus the frozen hash list of consumed inputs) is captured at prepare,
re-verified immediately before the oracle runs and again before its result is accepted, and any
replacement is a stop — a matching pathname or file-hash alone never proves stateful oracle identity
survived. Contracts referenced by path keep their existing prepare-time freeze; the grading-time
re-verification is new. Regression: swap only the oracle root (consumer root and file contents
preserved) and the round must stop.

### 3.4 DL-1 — Per-case deadline ownership (F7)

Each case freezes a bounded, owner-selected outer deadline with an explicit clock scope, and a
separate cleanup grace that is never borrowed for execution. Custom-round keeps its continuable,
unjudged timeout outcome behind the existing receipt/cleanup/settled-tree gates. Standard acceptance
adopts the same continuation **only** with equivalent gates; uncertain cleanup still stops all
further spend. The production default deadline becomes a named constant documented as a default, not
a policy; no specific duration change is justified by retained evidence and none is made.

### 3.5 AF-1 — Doctor surfaces the retained HTTP status (F1)

`doctor --probe` reuses the existing sanitized failure projection instead of collapsing it: the
printed line carries the observed status (for example `HTTP 451`) plus fixed actionable guidance —
disable the backend in config or resolve access with its operator. No causation wording, no new
transport behavior.

### 3.6 AF-2 / AF-3 — Bounded evidence tests (F8, F9)

AF-2: one sentinel-only process-chain test — owned synthetic startup files; a descendant that
acknowledges readiness after inheriting its descriptors; record presence booleans for the disputed
key set and marker equality before and after leader exit; correlate owned worker and descendant
identities; reap the recorded PID in `finally`. The claim it supports stays "spawn-environment
filtering plus the tested startup-channel mitigation" — real-codex tool-descendant behavior requires
a separately identified native observation and is not claimed.

AF-3: the lingering-descendant fixture acknowledges readiness before the test aborts (bounded
watchdog on the acknowledgement), stays alive until explicit test cleanup, and is reaped by its
recorded PID. No sleep, no retry, no accepting either outcome, no product semantics change.

### 3.7 Evidence rule for coverage claims (F3, no code)

Admission suites rebind profile mappings per tuple, so tuple admission is evidence of execution
under a forced pair, never of natural selection. Any claim of six-profile natural coverage requires
natural runs with unchanged mappings and substantive tasks on the claimed baseline, reported with
actual selections and remaining gaps, labeled separately from admission. This rule binds future
campaigns, not this codebase.

## 4. Verification

Offline only; zero paid calls. New/adjusted tests:

1. SC-1: prepare-time schema validation (bounds, refusal wording, no spend on reject); executed
   case stages the schema (managed-home path pinned) and the receipt reflects codex-side
   enforcement; schema-less manifests unchanged.
2. EV-1: fake-worker lifecycle record — milestone ordering, capacity overflow preserves terminal
   milestones, record persisted before settlement (verified by reading it after an outer kill),
   projection degrades absent fields without fabricating; no raw text anywhere in the record.
3. OR-1: oracle-root swap (consumer root and contents intact) stops the round; pathname-preserving
   content replacement stops at re-verification; legitimate unchanged oracle passes.
4. DL-1: per-case deadline respected (clock scope pinned); timeout is unjudged and the next case
   runs in both harnesses; cleanup-grace boundary is not extendable by execution; uncertain cleanup
   still stops.
5. AF-1: probe failure line carries the observed status and fixed guidance; cancelled-vs-failed
   unchanged.
6. AF-2: sentinel chain assertions (key set, marker equality, before/after leader exit) with
   readiness synchronization; suite green.
7. AF-3: readiness-synchronized fixture passes a bounded repeated run under load (the historical
   flake shape), no other semantics touched; full suite green.

## 5. Non-goals

Per-finding avoid-list, binding on implementation:

- F1: no transport rewrite, proxy discovery, automatic retries, circuit breakers, or deprecating the
  backend on an inferred regional diagnosis.
- F2: no product-side schema engine, model escalation, retries, arbitrary JSON extraction, or oracle
  weakening to obtain a pass.
- F3: no resumable/replayable historical manifests; no forced mappings presented as natural coverage.
- F4: no raw transcripts, stderr archives, or general tracing infrastructure; no deadline increase
  disguised as a fix.
- F5: no generic filesystem-identity framework or recursive watching; hash-or-pathname alone is not
  identity.
- F6 (gate): routing-policy changes require discriminating multilingual calibration evidence first —
  matched dev/held-out tasks, frozen candidate criteria, resource evidence for any "cheaper
  sufficient profile" claim. Until that exists: no keyword overrides, language-specific clamps,
  confidence thresholds, or router replacement.
- F7: no universal deadline increase, adaptive/model-based timeouts, or progress-based resets.
- F8: no real-key dumps, host startup-file inspection, arbitrary process-tree scanning, or boundary
  expansion beyond the tested mechanism.
- F9: no longer sleeps, retries, accept-either outcomes, or suite serialization.

## 6. Review record — 2026-10-17 astra re-check

One authorized review call through turnhelm (Laya/direct selected `gpt-6-astra`/`high` via profile
`balanced`; worker completed in 280.2 s, 50 progress events, `codexHomeManaged: true`; root
`astra-findings-20261017-103512`; report `review-stdout.txt`, 20,755 B). A first invocation attempt
was refused by the CLI's own usage validation (`-` positional with stdin) before classification —
zero spend. Verdict, condensed: "Main closes several protocol defects, but does not close the
historical evidence gaps; prioritize oracle identity, bounded lifecycle evidence, explicit case
contracts/deadlines, and deterministic cleanup verification."

Adjudication: all nine dispositions accepted after spot-checking the load-bearing citations in
source (`src/systemone.ts:180`, `src/doctor.ts:75`, `test/custom-round.ts:560,1161`,
`test/live-acceptance.ts:730`, `test/live-acceptance.test.ts:833,2263` — all confirmed). The
reviewer's per-finding "unresolved by available evidence" holdings (F1 causation, F2 why, F4 deep
cause, F5 historical implementation, F6 attribution, F8 historical descendant, F9 historical timing)
are adopted as the spec's claim ceilings: this spec fixes evidence gaps and contracts, and does not
assert any of those attributions. Reviewer's SPEC partition (one spec: F2/F4/F5/F7; small fixes:
F1/F8/F9; deferred: F6) accepted and mirrored in §1.
