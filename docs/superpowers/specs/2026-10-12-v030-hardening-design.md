# v0.3.0 Validation Hardening Spec

Date: 2026-10-12. Code baseline: `dec9d7af96cdc456986926b4e0d7d2420478f1a6` (tag v0.3.0). Input: the sealed v0.3.0 dynamic-routing validation report (`/private/tmp/turnhelm-routing-validation-v030-20261012-1TAxtD/REPORT.txt`, report SHA-256 `1b62b3cf…12c`, seal `f886d5c5…2690d`), verdict PARTIAL, all spend authority closed.

> Status: drafted under the user's authorization to branch, write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, paid calls, or publication. §10 records the review round's dispositions; this revision incorporates all of them. Selection lens: long-term benefit, security, performance only — backward compatibility is explicitly not a constraint.

## 1. Findings and decision boundary

Round facts: 26/28 reserved workers completed, 52 real Laya classifier attempts; natural tasks 16 pass / 2 fail / 2 invalid-oracle; policy 35 match / 9 mismatch; six re-bound admissions completed; dual/Jev suites and three paired baselines unexecuted (operator stop); zero valid paired comparisons. All v0.2.0 hardening behaved as designed under paid load: the WH-2 envelope accepted two footer admissions, the kill ladder and `ownedShutdown` attribution held on both SIGTERM paths, and `BASH_ENV`/`ENV` stripping survived real worker environments.

The round's losses were not product-lifecycle failures. They were **evidence-pipeline failures**: every wasted worker traces to a primitive the round tooling re-implemented privately instead of importing from the repo, to a check that ran only at preparation time, or to a signal the product discards at kill time.

| Report finding | Adjudication | Disposition |
| --- | --- | --- |
| `business-strict-output-failure` (16-readonly-distributed, retained FAIL): first line correct frozen facts, whole stdout fails strict contract, 198 bytes | The round tooling graded with a private strict whole-stdout oracle (`stdoutMatches`, `business-run.mjs:12`) while the repo ships the adjudicated WH-2 envelope — but the envelope is fused to the harness's `{count, sum}` payload check (`jsonEquals`, `test/live-acceptance.ts:1347`) and not importable, so tooling with different payload shapes re-implemented it stricter. Case 16's FAIL was **correct under its frozen strict-only contract** — the defect is prospective: a future round freezing a strict-only contract re-creates the same spend loss | §4 — export a payload-agnostic envelope primitive; the frozen-contract decision itself stays with each round's manifest |
| `envelope-accepted-not-strict-json` (2 admissions, 84/81 bytes) | Same root, benign outcome: the harness envelope worked as designed. Confirms workers append footers regardless of task text saying "nothing else" — phrasing alone is proven not to fix this | §4 — no prompt-text change promised; the envelope is the contract |
| `invalid-oracle` ×2 (17/19): EPERM `uv_cwd` before module execution, paid grades invalidated, round stopped | Three compounding defects: (a) seatbelt profiles are frozen artifacts with absolute `subpath` allow-reads bound to the prep-time consumer root (`policy` at `freeze.mjs:11`, called with `c.root` at `:16`); (b) the RED/GREEN sandbox checks ran only at preparation (`freeze.mjs:14–19`) — the supplement's copied roots invalidated them silently; (c) when the oracle infrastructure then failed at execution, `business-run.mjs:114–115` collapsed it to a per-case `independentContract: false`, and `mustStop` (`:15`) excludes that key — so spending continued through 19 and into the baseline until the operator stopped it | §4 — root-parameterized policy + binding checks that run **before spend**, exported from the repo; §4.3 gate adds the infrastructure-vs-assertion stop distinction |
| `owned-closed-outer-timeout` (15-readonly-security, 240 s, SIGTERM, `ownedShutdown: true`, stdout 0 bytes, cause unknown) | The lifecycle is correct; the evidence ceiling is the gap. A cancelled run retains **nothing** about event-stream liveness — second consecutive round where a killed worker's internal state is unknowable (case 14 → WH-1 taxonomy; case 15 → even `failureClass` is absent on cancel) | §3 — sanitized decoded-event counters on every worker result |
| `predeclared-policy-mismatch` (9/44: six under-band business selections, three over-band calibration trials) | Policy fact, not a quality failure; five of six under-band business selections in v0.2.0 passed their checks. Criteria v1 retained in production; the v2 experiment (200 free local calls) failed its predeclared gates | Non-goal (§6) — no criteria change without new evidence |
| Absent-summary continuation unpinned (v0.2.0 review mutation finding, `221023`) | A plausible regression (absent summary → integrity-style stop) passes the entire committed suite today; `live-acceptance.test.ts:1283–1288` pins the oracleInput shape but not that the roster continues | §5 — one continuation pin |

**Decision boundary.** Three surgical workstreams: one product change (§3, `src/`), one validation-primitive change (§4, `test/` exports — the code is deliberately not in `src/`: oracles are validation, not product, and `dist/test/live-acceptance.js` is already the import surface round tooling uses), one test-honesty pin (§5). No backward-compatibility constraints: receipt fields are added unconditionally; old sealed evidence is never re-consumed and needs no migration.

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: three workstreams (§3–§5) | Closes both paid-loss classes at their shared root (private re-implementation of repo primitives, prep-only validation, infra-failure misclassification) and the only remaining undiagnosable kill class; nearly all changes are exports, counters, and tests | **Adopt** |
| B: process-only (next-round checklist items, no code) | Relies on discipline where a tested primitive can exist; the v0.3.0 round *had* the WH-2 envelope available and still lost a worker to a strict private copy | Reject |
| C: criteria v3, worker deadlines, retries, transcript retention, profile parsers, moving oracles into `src/` | Each adds mechanism without adjudicated need: deadline/retry change the supervision architecture the report validates as working; a profile parser duplicates what byte-equality regeneration proves for free; `src/` placement ships validation code in the product binary | Reject (§7) |

## 2. Scope, inheritance, and invariants

Files changed: `src/codex.ts`, `src/cli.ts`, `test/cli.test.ts`, `test/live-acceptance.ts`, `test/live-acceptance.test.ts`, `test/worker.test.ts`, `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (kept in doc parity), this spec, and the plan. Not changed: `src/codex-events.ts` (taxonomy frozen), `src/route.ts`/`src/systemone.ts` (criteria v1 byte-identical), `src/config.ts` schema (v1), `src/journal.ts` (routing-only, hash-only — worker progress never enters the journal), manifest/corpus schemas (v2), exit-code semantics, the kill ladder and all its timings, the frozen stop policy of the *repo's* harness, dependencies.

Inherited unchanged: one-receipt policy; journal-before-worker ordering; sticky-failure irreversibility; TERM→KILL escalation and discharge gating; one attempt per eligible backend with the 3/4–1/4 deadline split; Jev triple gate; evidence whitelisting with bounded `oracleInput`; caps and once-only manifests; no-retry.

## 3. WH-5 — Decoded-event evidence on killed runs (src/)

`executeWorker` already decodes every event through `dispatch`. Add two counters, nothing else:

- `progressEvents: number` — count of **successfully decoded events of all kinds**, including `ignored` and `diagnostic` frames. The signal is parent-observed transport liveness, not model output: unknown event types and error-class events count, malformed frames do not (they are protocol failures on their own path). Incremented only on successful `decodeWorkerEvent`.
- `lastEventAt` — `performance.now()` at the last successful decode; undefined while none.

Both flow to `WorkerResult` and the receipt's `worker` object: `progressEvents` is **required on every result and receipt** — including the `not-started` receipt (0) and the pre-start abort path (0) — and `lastEventAgeMs` (rounded age at settlement) is present iff `progressEvents > 0`. No event text, no kind breakdown, no timestamps beyond the one age — the WH-1 disclosure discipline is unchanged; this is two integers. The diagnostic sink, stdout, and the journal are untouched.

**Semantics and limits, stated exactly.** These fields report what the *parent observed*: events counted at decode time, and an age measured from the last decode to settlement. Backpressure (a blocked output sink pausing `processFrames`) can delay decoding of already-received bytes, and shutdown discards buffered frames, so `lastEventAgeMs` may overstate the true idle time and can never prove the child was idle. `progressEvents: 0` on a cancelled run narrows the hypothesis space — no frame ever decoded — but does not diagnose the child's internal cause, which stays unknown exactly as the report says. The value is the 0-versus-recent distinction between "died before any decoded frame" and "frames were still decoding near the kill", which is the one fact a supervisor needs to choose between investigating startup hangs and tuning outer deadlines. The failed/`workerFailure` projection path is unchanged (failed runs already carry their class).

### 3.1 Harness projection

The observed evidence record gains `workerProgress: Readonly<{ events: number; lastEventAgeMs?: number }>` — present only when the receipt's `worker.progressEvents` is a safe integer ≥ 0 (all-or-nothing on `events`; a malformed `lastEventAgeMs` drops that field alone). Fixed keys, no free text, same validation idiom as `workerUsage`/`workerFailure`.

## 4. VH-5 — Single-sourced oracle primitives for round tooling (test/)

Both paid-loss classes share one root cause: round tooling imported `superviseCli` from `dist/test/live-acceptance.js` but re-implemented the primitives it could not import. Export the primitives, payload-agnostic, and gate the tooling on using them at the right time.

### 4.1 The envelope, separated from the payload

Export a payload-agnostic envelope validator from `test/live-acceptance.ts`. Contract: given whole stdout text, it validates envelope **shape only** — line 1 parses as a JSON value, every remaining line is inert by the existing `inertTrailerLine` rule (no `{`/`[`/`"` opener, no code-fence delimiter, not itself valid JSON) — and returns the parsed line-1 value; the caller supplies the payload predicate (the existing `{count, sum}` `jsonEquals` becomes one such consumer, its behavior and tests unchanged). This is what case-16-shaped contracts need: their own facts predicate under the same adjudicated envelope.

The whole-payload-exact alternative (strict `JSON.parse` of all stdout) remains available to any round that deliberately freezes a strict-only contract — §1 records why that choice now has a demonstrated cost; the repo does not forbid it, it just stops re-implementing the envelope to get it.

Tests: the existing envelope suite stays green untouched; add direct negatives for the two shapes it does not pin — a same-line object pair (`{"count":0,"sum":0} {"count":8,"sum":8}` as a trailer) and a complete array wrapper around the payload — plus one positive/negative pair exercising a non-`{count,sum}` payload predicate, proving the primitive is payload-agnostic.

### 4.2 The oracle sandbox policy, derived and checked before spend

Export from the same module, lifted verbatim from `freeze.mjs:11` (identical SBPL semantics — no behavior change for future rounds):

- `oracleSandboxPolicy(options: { runtimeDir: string; allowReadSubpaths: readonly string[] }): string`
- The consumer-side contract: **profiles are derived, never frozen**. The binding check is regeneration-equality — regenerate the expected profile bytes from the live case root's `realpath` and the current runtime dir, and refuse on any byte mismatch. Stale root, stale node runtime, and any hand-edit are all the same mismatch; no profile parser exists or is needed (§7).

**Check placement is the actual fix** (review P2-2): the check runs (a) at manifest preparation over every case in the final execution roster — before any reservation, classifier call, or worker spawn — and (b) again immediately before each contract/oracle execution, over the same live root. The v0.3.0 loss happened precisely because the only checks ran at prep against roots that were later copied.

Tests: same-root regeneration passes; crossed-root fails (the exact 17/19 shape); a different `runtimeDir` fails (the stale-node shape).

### 4.3 Round-tooling gate (process, not code)

Three requirements for the next round's tooling, enforced by review against this spec:

1. **No re-implemented envelope or sandbox-policy logic.** Task-specific payload *predicates* are legitimate and expected; duplicated envelope/trailer/policy mechanics are a review-blocked defect.
2. **Zero-spend ordering.** A stale or mismatched binding at preparation must abort with zero classifier requests and zero worker spawns. The round tooling carries a regression test proving exactly that (a stale profile in the roster aborts before any spawn), because interpolation (`policy(A) ≠ policy(B)`) alone proves nothing about ordering.
3. **Infrastructure failures stop spending.** An oracle-runner infrastructure failure (sandbox denial before the check's own assertions run, check-process spawn failure — detected from the runner's trusted exit semantics, never by regex over model or runner stderr) is an **integrity stop**: the roster halts with no further reservation or spawn. An assertion failure of the check itself is an ordinary case failure that continues per the existing stop policy. The v0.3.0 continuation through 17→19→baseline after an infrastructure failure is the exact behavior this forbids; the round tooling carries two tests — injected infra failure stops with no second spawn, ordinary contract failure continues.

## 5. TH-1 — Continuation pin (test/)

One test in `live-acceptance.test.ts`: a two-case `worker-write` roster where case 1 writes no summary file (oracle failure, every integrity check true) and case 2 writes the correct summary. Pins: roster **continues** — both workers run, both cases reach `verified`, case 2's oracle passes — exit 4 with `failed: 1`, no `stopped` record, case 1 `oracleInput` is `{source:"summary-file", text:null, bytes:null}` with `checks.oracle === false`. This is the mutation from finding `221023` turned into a regression test; it pins exit code, spawn count, and terminal-record shape, which the committed suite provably does not.

## 6. Non-goals

- **Routing criteria**: v1 stays byte-identical. Band mismatch is a policy fact; the v2 experiment failed its predeclared gates; no v3 is authorized by this spec.
- **Worker-level deadlines/retries in the product**: outer supervision belongs to the parent agent — the round proves that path works (case 15's kill ladder executed correctly). A built-in deadline would move supervision into the product with no adjudicated failure to cure.
- **Regrade/replay**: sealed rounds stay sealed; case 16's FAIL stays a FAIL; the two offline corrected-root diagnostics in the report remain diagnostics.
- **Jev 451 / dual suites / paired-cost**: external or next-round scope decisions, not code.
- **Env isolation ceiling, `.git` tree-check ceiling**: documented, unchanged.

## 7. Rejected alternatives

Retry-any-failure (authority surface, breaks the stop policy the round validates); transcript/stderr retention for diagnosis (221371 lens-e proved redaction cannot make native text safe; WH-5 counters answer the liveness question without retention); a seatbelt profile parser (byte-equality regeneration proves more with less); exporting oracles from `src/` (ships validation code in the product binary; `dist/test` is already the tooling import surface); a `--deadline` flag (supervision architecture change, see §6); confidence-based escalation (unverified signal, no new evidence); stderr-regex infrastructure-failure detection (untrusted text shaping a spend decision — §4.3 uses trusted runner exit semantics instead).

## 8. Test matrix

| Area | Checks |
| --- | --- |
| WH-5 worker unit | exact `progressEvents` including `ignored`/`diagnostic` events and excluding malformed frames; no-event failure and pre-start cancellation both carry `progressEvents: 0` with no age; cancelled-mid-stream carries count + age; completed run carries both |
| WH-5 delivery path | cancelled worker → real CLI receipt (executed path) → persisted `workerProgress` in evidence → roster stop record; `not-started` receipt carries `progressEvents: 0` |
| WH-5 projection validation | `workerProgress` projects from a valid receipt; malformed `events` drops the projection; malformed `lastEventAgeMs` drops the field only; no unknown fields or text pass |
| VH-5 envelope | existing envelope suite unchanged; new negatives: same-line object pair, array wrapper; payload-agnostic predicate positive/negative |
| VH-5 sandbox policy | same-root regeneration passes; crossed-root fails; stale `runtimeDir` fails |
| VH-5 round-tooling gate (next round's tooling, required by §4.3) | stale binding aborts with zero requests/spawns; infra failure stops the roster with no second spawn; ordinary contract failure continues |
| TH-1 | absent-summary continuation pin per §5 |

## 9. Risks

Counters add two fields to a hot path that is pure arithmetic — no measurable cost. Receipt growth is bounded by two integers. The export surface adds no new authority: round tooling already imports from `dist/test`. The regeneration self-check depends on `realpath` stability between generation and verification — the check runs at preparation and again pre-execution over the same live root, and a false mismatch fails closed (refuses to run/spend), which is the safe direction. `lastEventAgeMs` is parent-observed and backpressure-bounded (§3); docs must word it as observed age, never a stall or liveness *claim*. The gate items in §4.3 bind only the next round's tooling; this repo cannot enforce them mechanically, which is why each carries its own required regression test at tooling level.

## 10. Codex review dispositions

Reviewed by codex `gpt-6-astra` (high) on 2026-10-12 against the draft spec, the v0.3.0 report, and current source. Verdict: changes required. All seven findings verified against source before adoption; none rejected.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | P1 | Exporting the existing `{count,sum}`-fused oracle cannot grade case-16-shaped payloads; envelope must be shared separately from payload validation; "custom oracle" prohibition overbroad; case 16 correctly failed its frozen contract | **Adopted** — §4.1 rewritten payload-agnostic (shape validator + caller predicate); §4.3(1) narrowed to envelope/policy mechanics; §1 row 1 restated as prospective loss, grade unchanged |
| 2 | P2 | Binding checks must run before spend, not only before oracle execution; prep-time RED/GREEN was invalidated by root copying; `policy(A)≠policy(B)` proves interpolation, not ordering | **Adopted** — §4.2 adds preparation-time check over the final roster (zero requests/spawns) plus pre-execution recheck; §4.3(2) requires the zero-spend ordering regression in round tooling |
| 3 | P2 | Oracle infrastructure failure collapsed to `independentContract:false` let spending continue (17→19→baseline); root-binding checks alone don't repair the classification | **Adopted** — §4.3(3): infra failure = integrity stop via trusted runner exit semantics; two required tooling tests; §7 rejects stderr-regex detection |
| 4 | P2 | WH-5 overstated: decoded events include unknown/error kinds; backpressure delays decode; shutdown grace discards frames — counters cannot claim "model output" or "actively streaming" | **Adopted** — §3 renamed to decoded-event evidence; semantics-and-limits paragraph added; disposition row reworded; docs must say observed age, not inference |
| 5 | P2 | WH-5 tests didn't pin the full delivery path (not-started receipt, CLI executed path, harness projection, stop record; malformed-frame exclusion; safe-integer validation) | **Adopted** — §8 WH-5 rows expanded to unit, delivery-path, and projection-validation tiers |
| 6 | P3 | Claimed existing envelope coverage inaccurate: same-line pair and wrapper shapes not pinned | **Adopted** — §4.1 adds both negatives plus a payload-agnostic predicate pair |
| 7 | P3 | "One-directional" mismatch claim wrong (three over-band calibration trials, six under-band business); anchor precision (`freeze.mjs:11` receives `allowed`, `c.root` at `:16`; strict parse line) | **Adopted** — §1 row 5 restated as 6 under + 3 over; anchors made precise. `stdoutMatches` cited at `business-run.mjs:12` (function declaration; its `JSON.parse` is the following line) |

Confirmed sound by the same review: TH-1 addresses the real gap (with the added both-workers/case-2-passes assertions now in §5); §§6–7 exclusions stand; missing hosted/paired validation establishes no additional product defect.
