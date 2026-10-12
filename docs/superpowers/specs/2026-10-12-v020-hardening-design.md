# v0.2.0 Validation Hardening Spec

Date: 2026-10-12. Code baseline: `401b578f1ee87fa0c5a4bf8d18f7d567700acdff` (tag v0.2.0). Input: the sealed v0.2.0 dynamic-routing validation report (`/private/tmp/turnhelm-routing-validation-v020-20261012-ZXakos/REPORT.txt`, approval SHA-256 `d92b1d63…5b3a`, seal `54df6861…`), verdict PARTIAL.

> Status: drafted under the user's authorization to branch, write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, paid calls, or publication. §10 records the review round's dispositions; this revision incorporates all of them.

## 1. Findings and decision boundary

Round facts: 15/16 natural business cases passed with natural routing across fast/balanced/frontier; 45/4 engineering pass/fail; 31/9 policy match/mismatch; all six admission pairs completed; budgets spent 24/26 workers, 50/52 attempts. This round is attributable to baseline `401b578` (source tree clean). Five of the six under-band business selections **passed their task checks** — band disagreement is a policy fact, not a quality failure (the report separates the two).

Four distinct failure classes, each adjudicated from the sealed evidence:

| Report finding | Adjudication | Disposition |
| --- | --- | --- |
| Two `oracle:false` admission failures (`gpt-6.1-sol/high`, `gpt-6-astra/xhigh`): every integrity check true, stdout was the correct `{"count":4,"sum":17}` followed by one benign prose line | Formatting, not arithmetic — the retained `oracleInput` (VH-1) proves the payload correct both times; the task text already says "nothing else" and the workers added prose anyway. **Stdout** cases only; no summary-file case failed | §4 — stdout oracle gains one narrow envelope; summary-file oracle unchanged |
| `14-shared-validation`: worker `failed`, exit 143, stdout empty, "native error text not retained; underlying cause unknown" | The parent's kill ladder SIGTERMs the group immediately on `turn.failed`, so 143 is ambiguous (owned shutdown vs external kill); `decodeWorkerEvent` discards the failure's message, so nothing diagnostic survives | §3 — failure deadline with group-cleanup contract, observed-shutdown attribution, failure-class taxonomy + hash |
| 9 band mismatches: 6 business under-selections (race→balanced, migration→fast, cleanup→balanced, path→balanced, redaction→fast, validation→balanced) + 3 heading-en over-selections | Systematic and one-directional on business cases. **Hypothesis, not proven cause:** the criteria phrasing may not give the small local classifier a usable reading of the same difficulty signals the band policy encodes (the instructions do already name them — `src/systemone.ts:179–182`). This is a policy-alignment question, not a worker-quality defect (five of the six passed) | §5 — criteria v2 policy-alignment experiment with predeclared, enumerated gates |
| `dual-jev-write`: hosted Jev HTTP 451 before the worker started | External origin answer (2026-10-12 diagnostic, J3: no patch) | No code. RR-07 stays open; process gate in the plan only |
| Limitation: env stripping is "not host filesystem secret isolation" | True and documented; one concrete residual hole is cheap to close: `BASH_ENV`/`ENV` startup hooks can re-import stripped material into non-zsh descendants | §6 — two-key strip. Broader isolation stays a documented non-goal (§7) |

**Decision boundary.** Unlike the 2026-10-11/12 harness-only specs, this spec changes `src/` — three surgical product changes (§3, §5, §6), each justified by adjudicated round evidence, plus harness changes (§4, and the evidence projection in §3.4). Not maintaining backward compatibility means: old receipts without the new fields remain valid history; the oracle envelope applies to future manifests only (each round freezes its own baseline); no sealed round is re-graded.

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: four surgical workstreams (§3–§6), tests + docs each | Removes the adjudicated oracle false-failure class and makes worker failures attributable from sealed evidence; runs a clean policy-alignment experiment on free local calls; zero new mechanisms beyond a bounded failure deadline and two env deletes | **Adopt** |
| B: harness-only fixes (loosen oracle, keep src/ frozen) | Leaves case-14-class failures unattributable forever and the 22.5% band mismatch rate standing; defers known product gaps to protect a freeze that exists for evidence, not its own sake | Reject |
| C: retry-on-failure, confidence-based escalation, transcript persistence, sandbox wrapper, new exit codes | Each adds authority surface, unverified model signals, or breaks the worker (host secret deny-read vs `~/.codex` auth); complexity without adjudicated need | Reject (§7) |

## 2. Scope, inheritance, and invariants

Files changed: `src/codex-events.ts`, `src/codex.ts`, `src/cli.ts`, `src/systemone.ts`, `test/codex-events.test.ts`, `test/worker.test.ts`, `test/task-routing.test.ts` (criteria-text pins, if any), `test/live-acceptance.ts`, `test/live-acceptance.test.ts`, `README.md` (receipt fields, oracle wording, worker-failure wording), `.agents/skills/turnhelm-routing/SKILL.md` (single source; the `.claude` symlink keeps pointing at it), and one new `docs/validation/2026-10-12-calibration-v2.md`.

Not changed: `.turnhelm/config.json` schema (v1), manifest/corpus schemas (v2 — new manifests pick up changed source hashes through the existing baseline freeze), the eight frozen calibration stimuli, `workerReadonlyTask`/`workerWriteTask` texts (§4 keeps both untouched), journal schema and hash-only policy, exit-code semantics (0/1/2/3/4, 130/143), the frozen stop policy, dependencies, `package.json`.

Inherited unchanged: one-receipt policy; journal-before-worker ordering; sticky-failed irreversibility; kill-ladder reach and TERM→KILL escalation; one attempt per eligible backend and the 3/4–1/4 deadline split; Jev triple gate; evidence journal whitelisting with bounded `oracleInput`; caps and once-only manifests.

## 3. WH-1 — Worker failure fidelity (src/, harness evidence projection)

### 3.1 Failure deadline with a group-cleanup contract

On the first `turn.failed` event: set `stickyFailed` (unchanged, still irreversible — a later completion cannot restore success) and start **one** bounded failure deadline (`FAILED_EXIT_GRACE_MS = 5000`). The deadline is not restarted by repeated `failed` events. The contract has three parts:

- **Leader close within the deadline** (the observable leader-end event; a same-group descendant holding inherited stdio can delay it — the repo already documents that hazard) records the leader's own exit code and observed signal. Settlement still requires the descendant-cleanup obligation discharged: with `stickyFailed` set, close triggers the existing group poll — group already gone ⇒ discharged, no signal sent; surviving group ⇒ the existing TERM→KILL ladder runs as cleanup, and the result is marked as an observed parent-initiated shutdown.
- **Deadline expiry discharges the obligation unconditionally, regardless of leader liveness** — leader alive, or exited with close still pending on inherited descriptors, expiry runs the existing ladder (`beginShutdown` semantics unchanged). This is the branch that guarantees an exited-but-not-closed leader can never leave cleanup unelegible.
- **Supersession:** caller cancellation (`onAbort`) and transport failures (`recordFailure`) bypass the deadline and run the immediate ladder directly — the deadline never delays a cancellation or restarts or extends the 1 s TERM grace (`TERM_GRACE_MS`, `src/codex.ts:46`). The deadline timer is disposed at settlement; no callback fires after settlement. Drain interaction: once shutdown starts (deadline expiry or supersession), buffered frames and pending drain waits are discarded per existing `beginShutdown` behavior — late output after a failed turn is deliberately dropped.

Worst-case added latency is 5 s on an already-failed run. Transport/protocol/spawn failures keep the immediate ladder — a broken pipe must not wait.

### 3.2 Failure class taxonomy, not message text

Native error text is **not** retained — regex redaction cannot establish confidentiality (short secrets, `password=…` shapes, and task-text sentences all survive token-pattern scrubbing; review finding P1-1). Instead, `decodeWorkerEvent` maps `error`/`turn.failed` frames to a **fixed failure-class taxonomy** by case-insensitive substring match on known Codex error phrasings (for example: `stream-disconnected`, `rate-limit`, `usage-limit`, `timeout`, `auth`, `overloaded`), plus one catch-all `unknown`. Alongside the class it emits `errorSha256`: the SHA-256 of the raw message bytes, present **whenever a string message exists** — matched or not — giving correlation across runs and evidence without disclosure (the same discipline as `taskSha256`); an absent or non-string message yields `unknown` with no hash. Nothing is invented. The class and hash flow to one stderr diagnostic line (`turnhelm: worker-failed: <class>`) and to the receipt. They never enter stdout, the journal, or `oracleInput`. A failed taxonomy match is `unknown` — the taxonomy may grow only by adding a new phrasing with a test, never by passing text through.

### 3.3 Attribution fields

`WorkerResult` gains `signal?: "SIGINT" | "SIGTERM" | "SIGKILL"` (the child's observed death signal; the union matches the existing exit mapping `src/codex.ts:49–54`), `ownedShutdown: boolean` (a parent-initiated group shutdown **was attempted** — an action record, not proof of causation: an external SIGTERM can still be the leader's actual cause of death while surviving descendants trigger our cleanup ladder; review finding P2-1), and `failureClass?`/`errorSha256?` per §3.2 — with `failureClass` also emitted as `"unknown"` for any failed status that saw no failure event (a non-zero exit or signal death without events), so an eventless failure still carries its class. `ownedShutdown` is a **required boolean on every worker result and executed-worker receipt** — `false` when no ladder ran (natural exit, eventless failure) — so downstream consumers never face an absent-vs-false ambiguity. The receipt's `worker` object carries `signal`/`failureClass`/`errorSha256` when present, and `ownedShutdown` always. Exit codes are unchanged; 143 after an owned shutdown stays 143, now with the attempt recorded. The claim on the case-14 class is bounded observability — the receipt distinguishes *what the parent observed and did*, not the child's unknowable cause.

### 3.4 Evidence projection (harness)

The acceptance harness's observed-record sanitizer reconstructs an allowlisted projection and would silently drop the new receipt fields (review finding P3). The observed evidence record therefore gains one bounded projection, `workerFailure: Readonly<{ class: <taxonomy literal>; errorSha256?: string; signal?: "SIGINT" | "SIGTERM" | "SIGKILL"; ownedShutdown: boolean }>` — **all-or-nothing on its required fields**: the projection is present only when the receipt reports a failed worker with a valid `failureClass` (the WorkerResult/receipt layer emits `failureClass: "unknown"` for any failed status that saw no failure event, so an eventless failure still projects) and a boolean `ownedShutdown`; a malformed required field drops the entire projection, while the optional `errorSha256`/`signal` drop individually when malformed. Fixed keys only, no free text, nothing fabricated. Without it, the next case-14-class failure is attributable only from session stderr, not from sealed evidence — the exact asymmetry VH-1 closed for oracles.

Tests (`test/worker.test.ts`, `test/codex-events.test.ts`, `test/live-acceptance.test.ts`): leader close within the deadline with a surviving TERM-ignoring descendant still runs cleanup and settles; deadline expiry with the leader alive **or exited-but-not-closed** (a descendant holding inherited stdio keeps the close pending) escalates unconditionally; repeated `failed` events start one deadline; cancellation during the deadline supersedes immediately without extending TERM grace; transport failure during the deadline supersedes immediately; no callback fires after settlement; `stickyFailed` survives a later completion; taxonomy mapping known phrasings; **canaries** — at the decoder level, a fake error message containing `password=p@ss.word!`, a short bearer token, and a task-text canary sentence yields class + hash only; and **end-to-end through the real CLI**: a fake worker emitting those hostile error events produces a receipt, stderr diagnostics, and evidence in which each canary literal is individually asserted absent (no 20+-char substring of the raw message either); 512-byte-scale messages hash without truncation ambiguity; the harness projection round-trips, drops the whole projection on a malformed required field, drops optional fields individually, and projects an eventless failed worker as `unknown`/`false`.

## 4. WH-2 — Narrow stdout envelope oracle (harness)

The current oracle parses the whole stdout/summary text, so trailing prose fails an otherwise-correct run. The sealed evidence adjudicates exactly one envelope: **a correct compact payload followed by benign prose**, on stdout only. The task texts do not require a one-line form, and the current oracle deliberately accepts legal whitespace/format variation (whole-document pretty-printed JSON passes today) — the replacement must not regress that (review finding P2-2). No general JSON-extraction mechanism is built.

`stdout-json` oracle becomes two rules, in order:

1. **Strict whole-document parse (unchanged):** `JSON.parse` of the entire stdout succeeds and satisfies the exact contract (plain object, exactly `count`/`sum`, safe integers, equal to expected). Every shape that passes today keeps passing — pretty-printed, compact, whitespace variation.
2. **Single bounded envelope:** rule 1 failed, *and* the first line parses as the exact-contract object, *and* every subsequent line is inert prose — no later line parses as any JSON value, no later line begins with `{`, `[`, or `"` (after optional leading whitespace), and no later line is a code-fence delimiter (a line whose start, after optional leading whitespace, is ```` ``` ````). This admits exactly the adjudicated footer class and rejects competing structured payloads and fenced trailers (a conflicting pretty-printed object, a JSON array, adjacent objects, a fenced block after a correct payload, and wholly fenced payloads all fail; the last also fails rule 1, so no accepted-today case regresses — fences never passed under whole-document strictness).

The `summary-file` oracle is **unchanged** (whole-document strict): no summary case failed in v020, the file is programmatic output, and the task requires exactly one JSON object in it. `oracleInput` retention is untouched and keeps recording the exact judged bytes for both sources. Task texts, corpus fixture, and calibration stimuli are unchanged.

Tests (`test/live-acceptance.test.ts`): both sealed v020 shapes pass (compact payload + one prose line); pretty-printed payload passes (rule 1); pretty-printed payload + prose fails; compact payload + conflicting pretty-printed object fails (structured trailer); compact payload + prose containing a JSON line fails; fenced payload fails; array-wrapped payload fails; zero candidates fails; wrong values/keys/non-integers fail; summary-file source keeps whole-document strictness including a prose-suffixed summary failing.

## 5. WH-3 — Routing criteria v2: a policy-alignment experiment (src/, free local calls)

**Question.** Under one frozen classifier and frozen texts, six genuinely coupled business tasks selected fast/balanced against deep+ bands while the trivial heading edit selected frontier. The instructions already name uncertainty, coupled constraints, verification, and consequences (`src/systemone.ts:179–182`) — the hypothesis is that their *phrasing* is not usable by the small local classifier (reported confidence 0.01–0.12, uncalibrated), misaligning it with the declared band policy. This is a routing-policy experiment; it makes no worker-quality, sufficiency, or savings claim, and none of the report's quality findings close on band matches (review finding P2-3). Any future savings claim still requires the v1 design's comparative worker quality/time/cost oracle (`docs/validation/2026-10-11-calibration-design.md:63–67`) under a fresh approval.

**Change.** Revise `CHOICE_INSTRUCTIONS` and `CHOICE_CRITERIA` in `src/systemone.ts`: keep the lightest-sufficient objective and the anti-keyword rule; strengthen how difficulty signals are phrased — coupled state across async/transactional boundaries, untrusted input at trust boundaries, cross-component causal tracing, verification burden, blast radius — and sharpen each profile's criterion to result-requirements. Same text for both backends; no backend-specific prompts, no band edits, no stimulus edits.

**Method (free local calls only).** Two phases with a strict data boundary:

- **Tuning phase (declared):** criteria may iterate against the *tuning set* — the 8 frozen calibration dev+holdout stimuli, the 16 frozen v020 business texts, and the 2026-10-11 variant texts. Total classify calls across the whole phase ≤ 200. The v1 holdout results are already published, so reusing them here is tuning data, not confirmation (review finding P2-4).
- **Confirmation phase (once, after freeze):** a **fresh holdout** — 4 new stimulus pairs (8 texts, en/zh) authored after criteria freeze, with bands predeclared from the v1 non-keyword rationale *before any classify call*, each classified once, never used for tuning. Plus one pass over the tuning set as an explicit fit/regression measure (not independent evidence).

**Gates (enumerated; failing any gate blocks the v2 criteria from shipping — v1 criteria stay in `src/`, and the miss is recorded as a finding):**

1. Fresh holdout: 8/8 band matches (the only independent evidence).
2. Tuning-set regression, per case (no aggregate that can hide regressions): the 10 previously-matching business cases (01, 02, 03, 04, 06, 08, 10, 13, 15, 16) must all still match; ≥ 4 of the 6 previously-mismatching cases (05, 07, 09, 11, 12, 14) must now match; calibration-holdout 12 trials stay in-band (12/12); calibration-dev heading-en moves into fast/balanced on all 3 trials.
3. Variant non-regression (all 6 variants in `2026-10-11-calibration-variants.json`), per recorded baseline (`2026-10-11-calibration-design.md` appendix): the light variants `heading-en-v2` (fast), `heading-zh-v2` (fast), `heading-zh-v1` (balanced), `decoy-en-v1` (balanced) must stay fast/balanced; the hard variant `auth-zh-v1` (frontier) must stay in the frontier family; `heading-en-v1` (frontier) sits on the declared boundary and is **uncontrolled** — recorded, not gated.
4. Determinism (blocking): zero divergence across the calibration suites' 3-trial repeats in the confirmation pass — the backend is observed repeat-stable, and divergence under v2 criteria is instability the other gates must not paper over. Any divergent stimulus fails this gate.
5. A classify request failure on any confirmation text is recorded as no-selection and counts as a non-match for the gate; it does not abort the pass; no retry.

**Iteration bound:** one retune attempt after a failed confirmation; the second confirmation must use a **newly authored** fresh holdout (the exposed one can never serve again). After that, gates decide: pass ships v2, fail keeps v1. Results, the frozen criteria text, and all raw calls are sealed in `docs/validation/2026-10-12-calibration-v2.md`; the v1 design doc stays as history. If the local classifier proves capacity-bound (both iterations fail), that is itself the recorded outcome — no further text tuning without a fresh decision.

**Out of scope:** any paid re-validation round (separate approval, fresh manifests under the new baseline), `routes.jsonl` changes, confidence-based escalation (§7).

## 6. WH-4 — Subprocess env: two more keys (src/)

`subprocessEnvironment` additionally deletes `BASH_ENV` and `ENV`: a non-interactive bash (or POSIX-shell) descendant sources `$BASH_ENV`/`$ENV` at startup — the same re-import hole ZDOTDIR already closed for zsh. One-line diff plus one test line; no behavior change for environments that never set them.

## 7. Non-goals and rejected alternatives

- **Native error-message retention (sanitized):** rejected — redaction cannot establish confidentiality (P1-1). The taxonomy + hash (§3.2) is the entire retention surface.
- **General JSON-extraction oracle:** rejected — narrow two-rule envelope only (§4); a general extractor accepts ambiguous artifacts (P2-2).
- **Host filesystem secret isolation via a `sandbox-exec` wrapper:** rejected. The Codex child must read its own `~/.codex` auth; a host-secret deny-read profile either breaks the worker or is so porous it pretends. The honest boundary — env stripping, ZDOTDIR, BASH_ENV/ENV, Codex's own sandbox, approval-gated `--write` — is documented, not re-architected on speculation.
- **Jev 451 remediation (retry, endpoint change, proxy):** rejected; origin-side answer, J3 stands. Plan adds only a process gate: before any suite reserving hosted cases, an authorized `doctor --probe` must have observed a Jev success, or the suite is not prepared.
- **Retries / automatic re-routing on worker failure:** rejected; a failed run means stop (frozen stop policy). WH-1 makes the failure attributable, not repeatable.
- **Confidence-gated escalation:** rejected; reported confidence is uncalibrated (clipped checkpoint) — it must not become a control signal.
- **Full transcript/stderr persistence, journal schema additions, new exit codes:** rejected; retention scope stays VH-1 `oracleInput` plus §3.2's class/hash and §3.4's projection; routing evidence stays hash-only; exit 4 already covers complete-with-failures.
- **Prompt/output-caching, deadline-split, or cap changes:** no adjudicated defect; unchanged.

## 8. Verification and gates

Per workstream: `pnpm test` green (hermetic unit tests listed in §3–§5); `pnpm run test:coverage` keeps 80/80/80 lines/branches/functions on `dist/src/**`. WH-3 additionally requires every enumerated gate in §5 on free local calls, recorded in `docs/validation/2026-10-12-calibration-v2.md`; a failed gate blocks the criteria change. WH-1's canary tests are release-blocking: no raw error text, short secret, or task sentence may appear in stderr, receipts, or evidence. No paid calls in this change; the paid re-validation round is future, separately approved work.

## 9. Open-findings ledger

- Footer-prose stdout-oracle failures: **closed for future rounds** by WH-2 (sealed v020 failures stand as adjudicated history).
- Case-14 unknown cause: the historical cause stays unknown (sealed); the class gains bounded observability — observed actions, attribution fields, and a correlatable failure class in sealed evidence. Not "never again unknowable": the child's internal cause remains unobservable by design.
- Band mismatches (RR-08 lineage): become the §5 policy-alignment experiment's to answer or to refute; quality/sufficiency findings do not close on band matches and keep their comparative-oracle requirement.
- RR-07 (hosted Jev): stays open, external; process gate only (§7).
- "Not host filesystem secret isolation": tightened by WH-4's two keys and otherwise restated as a documented boundary, not a solved property.

## 10. Review round record

Round 1, 2026-10-12, `gpt-6-astra` (effort high), read-only, verdict **PROBLEMS** — 2 P1, 5 P2, 1 P3. Dispositions, all incorporated in this revision:

| Finding | Disposition |
| --- | --- |
| P1-1 sanitized message text can disclose secrets/task text | Adopted — replaced by fixed taxonomy + SHA-256 (§3.2); canary tests release-blocking (§8) |
| P1-2 grace lacked settlement/cleanup contract (surviving descendants after natural exit; timer disposal; supersession) | Adopted — §3.1 full contract; test list extended |
| P2-1 `ownedShutdown` is an action, not causation; signal union missed SIGINT | Adopted — §3.3 reworded, union fixed, bounded-observability claim |
| P2-2 line-oracle rejected pretty JSON / accepted ambiguous payloads; summary-file regression | Adopted — §4 two-rule envelope, summary-file unchanged |
| P2-3 causal overclaim on criteria; quality findings must not close on band matches | Adopted — §5 reframed as policy-alignment experiment; §9 keeps comparative-oracle requirement |
| P2-4 holdout teaching-to-the-test (business texts in tuning; exposed holdout reused) | Adopted — §5 tuning/confirmation data boundary; fresh authored holdout, once, replaced on any retune |
| P2-5 gates not executable (variant misclassification, wrong baseline, aggregate hiding, unbounded calls) | Adopted — §5 enumerated per-case gates, call bounds, blocking semantics, no-selection rule |
| P3 harness sanitizer drops new receipt fields | Adopted — §3.4 bounded `workerFailure` evidence projection + documented limitation otherwise |

Round 2, same day, same reviewer, verdict **PROBLEMS** — 1 P1, 5 P2. Dispositions, all incorporated:

| Finding | Disposition |
| --- | --- |
| P1 cleanup omits exited-but-not-closed leader (descendant holding inherited stdio) | Adopted — §3.1: deadline expiry discharges the obligation unconditionally regardless of leader liveness; inherited-stdio test added |
| P2 hash contract contradiction (spec: unmatched no hash; plan: with hash) and "anchored" vs substring | Adopted — single rule in §3.2: hash present whenever a string message exists, matched or not; matching is case-insensitive substring |
| P2 projection could violate its declared type by dropping required fields; eventless-failed path unspecified | Adopted — §3.4 all-or-nothing required fields, optional fields drop individually; §3.3 eventless failed ⇒ `failureClass: "unknown"` |
| P2 canaries not exercised through the real CLI receipt path; "no free text" overbroad vs intentional `oracleInput` | Adopted — end-to-end fake-worker→CLI canary test, each literal asserted individually (§3.4 tests); free-text ban scoped to failure-derived metadata |
| P2 envelope admits fenced trailers | Adopted — §4 rule 2 rejects fence delimiters; payload-plus-fenced-trailer test added |
| P2 determinism gate non-executable (finding vs blocking undecided) | Adopted — §5 gate 4 is blocking: zero divergence |

Round 3, same day, same reviewer, convergence check, verdict **PROBLEMS** — 1 P2:

| Finding | Disposition |
| --- | --- |
| P2 optional `ownedShutdown?: true` contradicted the projection's required boolean — an eventless failure would lose its entire projection | Adopted — §3.3: `ownedShutdown` is a required boolean on every worker result and executed-worker receipt (`false` on natural paths); §3.4 validation unchanged and now guaranteed |
