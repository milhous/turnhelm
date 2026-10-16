# Coverage Gate Restoration

Date: 2026-10-16

Baseline: `330ff37e3745ee0e714f8a5338986d87974abb10` (main, clean; work on `spec/coverage-gate-20261016`)

Status: The user authorized this spec cycle from the sealed 2026-10-16 validation campaign, an astra re-review, spec updates, and an execution plan. Product implementation and new live executions remain unapproved.

## 1. Intent and evidence

Optimize for long-term value, security, and performance without backward-compatibility branches. The sealed campaign verdict is COMPLETE-WITH-FAILURES (`/Users/zhangxiao/.local/state/turnhelm/validation-20261016-330ff37-Us6zV7/REPORT.md`, sealed in `final-seal.json`). Of its findings, exactly one is an in-repo defect this spec fixes — the coverage gate, the campaign's only blocker of release readiness. Everything else converts to recorded no-change decisions.

The coverage finding and its root cause:

- Campaign evidence: both stock `pnpm run test:coverage` attempts exited 1 after `Warning: Could not report code coverage` (`offline/test-coverage.log`, both attempts); 587/587 tests passed. The isolation probe (`offline/test-coverage-isolated.log`, wrapper `coverage-isolation.cjs` = `delete process.env.NODE_V8_COVERAGE` in the runner process) let the collector finish at 72.93 lines / 91.11 branches / 94.81 functions — below the unchanged 80-line threshold — and was rejected.
- The gate was green one commit earlier: the sealed 2026-10-15 campaign (`595f77f`) recorded stock exit 0 at 95.58 / 91.51 / 95.37. The regression arrived with `330ff37` (#21), whose TERM→KILL ladder and linger fixtures multiply the child-exit paths that can collide with a coverage write.
- Fresh reproduction on this checkout (2026-10-16): two runs failed with the runner naming an empty shared coverage file (`Error [ERR_OPERATION_FAILED]: … coverage file is empty: …/node-coverage-*/coverage-<pid>-….json`); one run passed at 95.91 / 91.21 / 94.06. Load-sensitive race, not a deterministic logic failure.
- Mechanism, verified in-repo: `node --test --experimental-test-coverage` shares one V8 coverage directory with every descendant that receives `NODE_V8_COVERAGE`. Node reinserts the parent's `NODE_V8_COVERAGE` into any spawned child whose `options.env` lacks that own property — including constructed environments and `delete`-stripped spreads (Node `lib/child_process.js` env forwarding; probed 2026-10-16 on 24.11.0 and 26.5.0: omit-key and spread+delete both forward; an own property set to `undefined` prevents forwarding). Consequently **every** test-spawned node child currently carries coverage instrumentation, and the existing strip in `src/codex.ts:53` has been ineffective. A child whose death or exit-write collides with the reporter's sweep — the ladder's second rung killing a TERM-trapped worker mid-exit-write, or a reporter read during a late child's write — leaves an empty/partial JSON; the reporter then fails the entire report. A controlled check (each signal against a short-lived child explicitly carrying `NODE_V8_COVERAGE`) shows SIGINT/SIGTERM/SIGKILL deaths of a *running* child leave no file at all: the poison is specifically the mid-write collision, and only children whose exit is unordered (killed during exit, or unawaited at report time) can produce it.
- Child merge is load-bearing: a full manual `NODE_V8_COVERAGE` run wrote 1197 well-formed files including `cli.js` data; the isolation probe's 72.93% is the in-process-only floor (`codex.js` 7.13%, `cli.js` absent). Measured children — the live-acceptance/package harness entries and the worker-test harness children that import built `src/codex.js` — must keep the variable.

| Approach | Trade-off | Decision |
| --- | --- | --- |
| Make the strip real: own-property `NODE_V8_COVERAGE: undefined` at the shared product boundary (`subprocessEnvironment`) plus the audited disposable test spawns | One-line product fix corrects every worker/fake-worker descendant at once; test-side overrides only where a disposable child can die or be read mid-write; measured children keep coverage | Adopt |
| Strip at every kill-capable spawn site (original draft) | Wrong boundary: kill-capable sites include measured harnesses (worker-test harness children execute `src/codex.js` and normally complete); blanket stripping discards load-bearing coverage toward the 72.93% floor | Reject (review P2-1) |
| `delete`-based stripping anywhere | Ineffective on current Node: the key is reinserted unless the own property is present with value `undefined` | Reject (review P1-1, probe-verified) |
| Strip in every test spawn / isolation everywhere | Deterministic but reverts the gate to the 72.93% in-process floor — below the frozen threshold | Reject |
| Swap collectors (c8/istanbul); wrapper that retries or pre-cleans the stock command | New dependency / masks the race; neither fixes unordered child exits | Reject |
| Lower thresholds or narrow the include | Weakens the frozen gate to fit the failure | Reject |
| Rewrite CLI/codex coverage as in-process tests | Large brittle rewrite duplicating what the child E2E tests already verify | Reject |

Recorded no-change decisions for the remaining findings (none is new machinery):

- The four business failures are observed model-side output/implementation failures: three unchanged-implementation cases (worker emitted strict payloads, allowed files byte-identical to fixture baseline) and one `0n/0n` bigint division evaluated before the `|| 0n` fallback. The harness detected and failed all four exactly as designed — same disposition family as the 2026-10-15 `07-version` case. The campaign does not establish that the failures are stochastic, and because routing assigned different tasks to profiles rather than randomly assigning equivalent tasks, failure-location counts cannot exonerate or implicate a profile (the report's `causationLimit` wording governs). No output repair, retry, forced regrade, or band/profile change on this evidence.
- Band outcomes (matches, per REPORT.md): natural business 19/46 matched, 27 mismatched; calibration 21/24 matched across dev+holdout (dev 9/12, holdout 12/12); `deep`/`frontier_xhigh`/`frontier_max` never naturally selected. These are predeclared policy hypotheses, not optimality ground truth — third consecutive campaign with insufficient evidence to retune. Profiles, criteria, and budgets unchanged.
- Laya checkpoint temperature clamp (choice11+, 0.1005828→0.5): Laya-side, not configurable through `laya.serve`, impact unproven. No change.
- Proxy-exit attestation, host filesystem secret isolation, all-native-descendant verification, hosted usage/billing scope, off-machine backup: unchanged non-goals, separately authorized future work (carried from the 2026-10-15 spec).
- Native exit-143 observations on completed workers: already resolved by #21's terminal-event settlement; no further change.

## 2. Scope and invariants

Scope: `src/codex.ts` (`subprocessEnvironment` only) and the audited test spawn boundaries — `test/worker.test.ts` (pin), `test/executable-fixture.ts` (`prepareExecutable`), `test/custom-round.ts` (sandboxed-check launcher), `test/live-acceptance.test.ts`, `test/proxy-transport.test.ts`, `test/direct-transport.test.ts` (sites reached by the audit; harness behavior otherwise untouched). Unchanged: all other `src/` product code; the frozen `test:coverage` command and its 80/80/80 thresholds over `dist/src/**` (`package.json:18`); the offline suite (587/587); live-acceptance/custom-round harness logic (env hygiene at spawn boundaries only, no behavioral edits); no new dependencies, configuration, origins, or requests. The routing skill and README do not document `NODE_V8_COVERAGE` handling, so no doc sync is required.

## 3. Coverage env hygiene — CG-1

Invariant: a child that is disposable (never measured — its files cannot land in `dist/src/**`) must not receive `NODE_V8_COVERAGE` when its exit can be unordered (killed during exit, or unawaited at report time). A child is measured only when it executes `dist/src/**` code; measured children keep the variable unconditionally. Because Node reinserts the variable into any env lacking the own property, every strip is an explicit `NODE_V8_COVERAGE: undefined` own property — `delete` and omission do not work.

1. Product boundary: `src/codex.ts` `subprocessEnvironment` replaces the ineffective `delete copy.NODE_V8_COVERAGE` with `copy.NODE_V8_COVERAGE = undefined` (comment: cite Node's env-forwarding reinsertion). Every real and fake worker descendant crosses this boundary; none is measured.
2. Test-side audit — classify each spawn site in `test/` by child class and exit ordering, applying the override only to disposable-and-unordered sites. Initial candidates from review P1-2: `test/executable-fixture.ts` `prepareExecutable` (owns the fixture SIGKILL path at `test/executable-fixture.test.ts:129`), `test/custom-round.ts:119-129` sandboxed-check children, `test/proxy-transport.test.ts` `runNode` guard children, `test/direct-transport.test.ts:558` and `test/live-acceptance.test.ts:106/2397` implicit-inherit spawns, and the linger fixture (`live-acceptance.test.ts:875`). Sites whose children are measured (worker-test harness spawns importing `src/codex.js`, live-acceptance/package harness entries, `cli.test.ts` baseEnv children) stay untouched. Each decision is recorded in the plan's audit table with its child class and exit ordering.
3. Observation pin, not an env-object assertion: a test spawns a real child under a synthetic parent `NODE_V8_COVERAGE` value and asserts the child does not observe it across the product boundary (negative control), and a measured-boundary child still observes it (positive control). The existing `worker.test.ts:471-481` pin is upgraded to the real-child form.

## 4. Security and performance

The product fix closes a real leak: production worker children currently receive the parent's coverage instrumentation path whenever a Turnhelm parent runs instrumented. The override adds one property to an already-copied env object; no measurable cost. Test-side overrides touch only disposable fixtures. No new secrets, origins, or product environment variables; gate runtime stays ~90-100 s.

## 5. Acceptance and authority

TDD with synthetic envs and real spawned children; no real Laya/Jev/worker execution is authorized by this spec.

| ID | Required evidence |
| --- | --- |
| CG-AC-01 | Product boundary: a real spawned child under synthetic parent `NODE_V8_COVERAGE` observes nothing across `subprocessEnvironment`; audit table records every test-side site with child class and exit ordering, overrides only at disposable-and-unordered sites |
| CG-AC-02 | Positive control: a measured-boundary child (worker-test harness or CLI spawn) still observes the variable, proving the override did not over-reach |
| CG-AC-03 | `pnpm run test:coverage` exits 0 with all-files ≥80/80/80 and no `Could not report code coverage` warning; retained line/branch/function numbers recorded in the plan; five consecutive runs including at least one under recorded parallel load — stress evidence of the fix, not proof of determinism (the reporter's sweep race with measured children is inherent to Node's runner) |
| CG-AC-04 | Unmodified `pnpm test` 587/587; typecheck, audit, and diff checks pass; `package.json` byte-identical to baseline; `src/` diff limited to `subprocessEnvironment` |

Stages: (1) this spec, astra review, updated spec, and plan only; (2) implementation and offline verification under a separately chosen execution method; (3) the release-readiness finding closes only when the next authorized validation campaign re-freezes a green coverage gate — no new live authority is granted here.

## 6. Review disposition

Reviewer: isolated read-only Codex child, gpt-6-astra/high (profile `deep` selected by Laya/direct, routing 1351 ms, worker 306.9 s, strict payload), 2026-10-16, project root `/Users/zhangxiao/.local/state/turnhelm/astra-review-20261016b`. Draft verdict **PROBLEMS: 2 P1 + 4 P2**. The parent re-verified the load-bearing finding by direct probe and accepted all six:

| Finding | Correction |
| --- | --- |
| P1-1: `delete`/omission does not prevent inheritance — Node reinserts `NODE_V8_COVERAGE` into any child env lacking the own property; existing `src/codex.ts:53` strip ineffective; `undefined` own property works | Probe-verified on Node 26.5.0 (omit-key and spread+delete forward; own-undefined yields absent) and corroborated on 24.11.0 by the reviewer; §1/§3 rewritten around the explicit `undefined` override; the product boundary fix adopted as the primary change |
| P1-2: audit missed implicit-inheritance sites (`direct-transport.test.ts:558`, `live-acceptance.test.ts:106/2397`, `prepareExecutable`, custom-round sandbox children, proxy-transport guard children); "already clean" claims false under reinsertion; `execFile` default killSignal is SIGTERM not SIGKILL; `package.test.ts` 300 s is a test timeout | Scope widened to the harness files; audit criterion rewritten as child-class × exit-ordering classification; killSignal and timeout wording corrected |
| P2-1: kill-capable ≠ coverage-free — worker-test harness children are measured (`src/codex.js` importers) and normally complete; blanket stripping discards load-bearing coverage toward the 72.93% floor; awaiting a killed child cannot repair a truncated file | Adopted as the measured/disposable split in §3; original "strip at kill-capable sites" approach moved to the reject table |
| P2-2: 19/46 and 21/24 are match counts, not mismatch counts; calibration population conflated dev+holdout | §1 corrected: natural 19/46 matched / 27 mismatched; calibration 21/24 matched (dev 9/12, holdout 12/12) |
| P2-3: "stochastic" and the 0.13 combinatorial exoneration overclaim — tasks were not exchangeable across profiles | §1 reworded to observed failures + insufficient causal evidence; no stochastic or statistical-exoneration claim; no-change decision retained |
| P2-4: env-object pin validates nothing (it passes today while inheritance is broken); helper tests cannot catch bypassing callers; five runs are stress evidence, not determinism proof | CG-AC-02/03 rewritten: real spawned-child negative and positive controls; stress framing recorded |

Parent-added (post-review, self-verified): the controlled signal-death check (SIGINT/SIGTERM/SIGKILL on a running child leave no file) now in §1, narrowing the poison to mid-write collisions; the reproduction series on this checkout (two empty-file failures, one 95.91/91.21/94.06 pass). The reviewer noted as unverifiable during the read-only review: full coverage reruns and live behavior — covered here by CG-AC-03's stress runs at implementation time.
