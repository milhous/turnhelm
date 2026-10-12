# v0.3.0 Validation Hardening — Round 2 Spec

Date: 2026-10-12. Code baseline: `bbbe0be` (head of `feat/v030-hardening`, stacked on tag v0.3.0 `dec9d7af96cdc456986926b4e0d7d2420478f1a6`). Inputs: the sealed v0.3.0 validation report (`/private/tmp/turnhelm-routing-validation-v030-20261012-1TAxtD/REPORT.txt`, unchanged since seal), the round-1 spec/plan (`docs/superpowers/{specs,plans}/2026-10-12-v030-hardening*`), the whole-branch acceptance-review ledger (2 Important findings fixed in `bbbe0be`, 3 Minors deferred), and the sealed round's tooling sources in the same sealed directory.

> Status: drafted under the user's authorization to branch (stacked on `feat/v030-hardening`), write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, validation-round spend, or publication. §9 records the review dispositions; this revision incorporates all eleven. Selection lens: long-term benefit, security, performance only — backward compatibility is explicitly not a constraint.

## 1. Findings and decision boundary

Round-1 state: the two data primitives the v0.3.0 round privately re-implemented are exported and tested (`envelopePayload`, `oracleSandboxPolicy` from `dist/test/live-acceptance.js`); killed runs carry `progressEvents`/`lastEventAgeMs`; the absent-summary continuation is pinned. Round 1's §4.3 gate binds the **next round's tooling** by review only — its §9 records the gap verbatim: *"this repo cannot enforce them mechanically."*

What remains open is flow-shaped. The v0.3.0 paid losses did not come from the primitives; they came from the runner that used them wrongly — and the runner is still per-round private code, rewritten from scratch every round (v0.2.0 wrote one, v0.3.0 wrote another). Until the repo owns the runner, every future round re-creates the two loss mechanics with nicer primitives available to ignore.

| Finding | Adjudication | Disposition |
| --- | --- | --- |
| Round tooling remains private per-round code; the two paid-loss mechanics live in the flow: (a) profile binding checked only at preparation (`freeze.mjs:14–19`) and silently invalidated when roots were copied; (b) oracle infrastructure failure collapsed to `independentContract: false` (`business-run.mjs:114–115`), a key `mustStop` (`:16`) excludes — spend continued 17→19→baseline until the operator stopped it | Root cause of both loss classes survives round 1. Exported primitives do not force a privately written `main()` to call them, in order, at the right time | **§3 RT-1** — a repo-owned custom-round runner in `test/`; the three §4.3 gates become code with a data-only round input |
| Deferred minor 1: the TH-1 continuation pin counts reserved evidence records, not actual fake-worker invocations | Correct observation; a runner that reserves but never spawns would pass the pin | **§4 TH-2** — the fake worker self-records invocations; the pin (and RT-1's zero-spend tests) assert that count |
| Deferred minor 2: the same-line object-pair negative exercises line-1 parsing, not the trailer rule | Superseded by existing coverage: `live-acceptance.test.ts:1528` already rejects a valid-JSON second line through `inertTrailerLine`, `:1529` a fence trailer. The minor is closed by coverage that exists, not by a new duplicate | Closed — no new test |
| Deferred minor 3: `lastEventAgeMs` tests assert numeric presence; a constant-zero implementation would pass | Honest-assertion gap. Decode timestamps at decode time (`src/codex.ts:492–493`) and a blocked sink can postpone the final decode (`:495`), so the gap must be constructed structurally, not by delaying emission | **§4 TH-2** — one forced-gap scenario delays *settlement* after the decode loop has quiesced; asserts `> 0` there only |
| `owned-closed-outer-timeout` (case 15): 240 s SIGTERM, stdout 0 bytes, cause unknown | WH-5 shipped the discriminating counters; no fresh live run has read them yet. Changing supervision before that evidence exists would be guessing | Keep round-1 §6 rejection; evidence bar: a fresh gated live run's counters |
| `predeclared-policy-mismatch` 9/44 | Policy fact; v2 experiment failed its predeclared gates; no new evidence exists | Criteria v1 stays byte-identical; v3 remains unauthorized |
| Jev 451 / dual suites / paired-cost comparisons unexecuted | External authorization scope, never code. The custom runner is local-Laya-only; dual/Jev/calibration suites stay with the standard harness, which already owns them | Non-goal; RT-1 neither enables nor runs them |
| Worker environment ceiling: the CLI child is not seatbelted; other shells' startup files and absolute host reads remain readable | An explicit scope/evidence decision, not a technical impossibility — the unchanged deny-network oracle profile cannot wrap a network-requiring child, but a network-permitting, filesystem-restricting profile is conceivable and remains unpursued for want of an adjudicated failure. The named-key scrub + `ZDOTDIR` redirect is the boundary the product ships | Documented ceiling stands; worker sandboxing parked as a decision, report caveats retained |
| Laya checkpoint temperature clipped; confidence uncalibrated | Backend-side; the repo cannot calibrate a checkpoint it loads | Non-goal |
| Offline output diagnostics, report and seal generators | One-off sealed-round artifacts with per-round shapes; not reusable primitives | Non-goal; stay round-private |

**Decision boundary.** Two workstreams: RT-1 (§3 — new `test/custom-round.ts` + `test/custom-round.test.ts`, exported through `dist/test` like `live-acceptance`) and TH-2 (§4 — two test hardenings inside existing test files). **No `src/` file changes at all this round.** No schema, journal, or standard-suite stop-policy change.

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: repo-owned runner (§3) + two minors (§4) | Closes the last mechanically unenforced loss class at its root: the flow itself. The runner absorbs paid-load-proven code (`freeze.mjs`, `business-run.mjs`) rather than inventing a framework | **Adopt** |
| B: export gate helpers only; runner stays per-round private | Helpers do not force a privately written `main()` to call them in the right order — the wiring risk remains exactly where the v0.3.0 loss happened | Reject |
| C: converge the custom runner into the standard `executeAcceptance` flow | Refactors a frozen, validated harness to deduplicate ~100 lines; the standard suites' stop policy is shipped product behavior the report validates | Reject |
| D: a framework with pluggable oracles/reporting/backends | One consumer today; speculative surface (over-engineering the mandate explicitly forbids) | Reject |

## 2. Scope, inheritance, and invariants

Files changed: new `test/custom-round.ts`, new `test/custom-round.test.ts`, `test/live-acceptance.test.ts` and `test/worker.test.ts` (TH-2 only), `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (doc parity), this spec, and the plan. Not changed: all of `src/**` (product frozen this round), `test/live-acceptance.ts` (RT-1 consumes its exports as-is), `src/codex-events.ts` taxonomy, criteria, config schema, journal, standard-suite manifest schemas, dependencies, CI workflow (the test strategy meets the existing Linux runner where it is).

Inherited unchanged: every round-1 invariant — one-receipt policy; journal-before-worker ordering; sticky-failure irreversibility; kill ladder and timings; discharge gating; one attempt per eligible backend; Jev triple gate; evidence whitelisting with bounded `oracleInput`; caps and once-only manifests; no-retry — plus the round-1 §4.3 gate semantics, which this round turns from review text into executable code.

## 3. RT-1 — Repo-owned custom-round runner (test/)

### 3.1 Shape, input, and authority

One module, two entry modes, mirroring the sealed round's proven CLI surface:

- `custom-round prepare <roster.json>` — freeze the round: validate the roster (schema, sizes, every task through `validateTask`), verify repo-HEAD and the consumed-file baseline, snapshot every case's consumer tree, and run bounded **local** sandboxed preflights over the final roster — reference GREEN, broken-fixture RED, and the sentinel isolation check, the checks `freeze.mjs:14–30` already ran — then emit the manifest + approval request for human hash-approval. Zero spend means **zero classifier requests and zero worker executions**; local sandbox preflights are subprocesses but not spend, and the classifier/worker counters are asserted at zero separately.
- `custom-round execute <manifest> <sha256>` — the gated run: exclusive-create evidence ledger (`wx`, mode 0600) at the manifest's canonical evidence root, per-case supervision via `superviseCli`, grading, stop policy, signal handling (first SIGINT graceful-stop, SIGTERM exits 143).

**The round input is data-only: a JSON roster.** Cases carry id, kind (`worker-readonly`/`worker-write`), scope, task text, transport (`arg`/`stdin-file`), consumer root, `allowedChanges`, `allowedProfiles`, and a declarative grading mode: strict-equal expected value (the v0.3.0 `worker-readonly` shape), envelope + deep-equal payload, or strict whole-JSON. No module is imported, no code path enters through the round input, and nothing executable is trusted from it: task files and startup hooks are data hashed into the manifest and only ever consumed inside the sandbox or by the CLI as task text. If a future round needs a code predicate, that round extends the runner in-repo — reviewed, tested, and hashed into its own baseline.

Everything with a failure mode is runner-owned: baseline verify, tree snapshot, root identity, both environment constructors, ledger, signals, grading, stop decisions. A round cannot re-wire a gate because a round writes no flow.

### 3.2 The three gates as code (the actual fix)

1. **Identity before spend; policy derived, never stored.** Before **every** reservation and CLI launch, the runner re-verifies each case's consumer root by canonical `realpath` equality with the prepare-time record plus `dev`/`ino` identity — the check that actually catches copied and same-path-replaced roots, where policy bytes would compare equal. Sandbox policy bytes are regenerated in memory from `oracleSandboxPolicy` at oracle-execution time and handed to the launcher directly; **no persistent profile artifact exists**, so there is nothing to go stale and no byte-comparison tautology. Runtime identity (node version, `execPath`) is pinned in the manifest and re-verified at execute.
2. **Infrastructure-vs-assertion, by a runner-owned outcome protocol.** The oracle/contract launcher is runner-owned: it spawns the check process with a runner-provided outcome path, applies the sandbox profile, and captures a structured result — spawn error, death signal, timeout, exit code, and the check's machine-readable outcome record. Classification: an explicit outcome record from the check (pass or assertion-fail) is graded normally — an assertion failure is an ordinary case failure and the roster continues under the frozen stop policy; a spawn error, signal, timeout, **missing or ambiguous** record, or any exit without one is an **integrity stop**: the roster halts, no further reservation or spawn. Nothing is ever inferred from exit code 1 alone or from stderr text. The v0.3.0 continuation through 17→19→baseline becomes structurally impossible because the stop predicate carries the integrity key the sealed `mustStop` (`:16`) lacked.
3. **No private grading primitives.** Grading is runner-provided and declarative: `envelopePayload` + the case's deep-equal payload, strict-equal, or strict whole-JSON `JSON.parse` (the deliberate strict-only contract, now a named mode with a recorded cost). Rounds carry data, never envelope, trailer, policy, or runner mechanics.

### 3.3 Stop policy (custom-runner scope)

Zero duplicate or retry invocations; boundary, drift, output-cap, cleanup, and infrastructure failures stop all remaining spend; output-only semantic misses continue to distinct frozen cases; auth, rate-limit, and usage-limit classes stop. Standard harness suites (laya/jev/dual/calibration) keep their shipped policy in the standard harness — the custom runner runs local custom worker rosters only. Exit codes: 0 all-pass, 4 complete-with-failures, 1 structural, 130 SIGINT, 143 SIGTERM.

### 3.4 Approval boundary

The manifest explicitly hashes everything execution consumes: the runner module and the imported primitives (`dist/test/custom-round.js`, `dist/test/live-acceptance.js`) under their repo HEAD, every case's contract/oracle/reference files, task transport files, and startup hooks, plus runtime identity (node version, `execPath` realpath) and the canonical evidence-root `realpath` — the only location an exclusive-create ledger claim holds for. Negatives pin each boundary: HEAD/dist mutation after prepare → execute refuses; roster or predicate-file mutation → manifest-hash refusal; relocated manifest → evidence-root identity refusal; concurrent claim → exclusive-create failure.

### 3.5 Two environment constructors, kept separate

The CLI child receives the sealed round's scrubbed environment (delete `TURNHELM_ALLOW_HOSTED_JEV`, `TYPESAFE_API_KEY`, `LAYA_API_KEY`, `OPENAI_API_KEY`, `BASH_ENV`, `ENV`, legacy `TURNHELM_CONFIG`); oracle and reference processes receive the **fresh allowlist** constructor (`contract()` at `business-run.mjs:61`: `PATH`, `HOME`/`ZDOTDIR`/`TMPDIR` bound to the case root, `LANG`, `TZ`) — never the runner's own environment. SBPL filesystem restrictions do not hide inherited variables, so the allowlist is the oracle's actual credential boundary. Tests assert an unrelated synthetic secret and `NODE_OPTIONS`/`NODE_PATH` are absent from the oracle environment.

### 3.6 Required regression tests

- Stale binding at prepare (root copied or replaced at the same path after prepare) → execute aborts at the identity check with zero classifier requests and zero worker invocations, asserted through the fake worker's invocation log and the classifier counter, not reserved records.
- Injected infrastructure failure at the actual launcher (spawn error, kill-signal, timeout, missing outcome record) → integrity stop, no second spawn; ordinary assertion failure → roster continues to completion (round-1 TH-1 semantics inside the custom runner).
- Grading modes: envelope + payload pass/fail, strict-equal, strict whole-JSON footer rejection (the case-16 shape).
- Approval boundary negatives from §3.4; ledger exclusive-create; SIGINT graceful / SIGTERM 143 / exit 0-4-1 mapping; caps never exceeded.
- Platform strategy: ordering, classification, approval, and lifecycle tests run everywhere CI runs (Linux included) against hermetic launcher/sandbox fakes; tests that execute real SBPL profiles are macOS-gated. No cross-platform sandbox implementation is built.

## 4. TH-2 — Two deferred test minors

1. **Spawn-count pin.** The fake worker in `live-acceptance.test.ts` records each of its own invocations (append to a file under its env-provided scratch path); the TH-1 continuation pin (and RT-1's zero-spend tests) assert that recorded count instead of reserved-record count.
2. **Age bound.** One slow-settlement worker scenario: the fake stream writes its frames and ends, the decode loop quiesces (no buffered or backpressured frames remain), and only then is settlement delayed by a forced monotonic gap — so `lastEventAt` is fixed before the delay and the test asserts `lastEventAgeMs > 0` deterministically. All other scenarios keep `Number.isSafeInteger` presence assertions. The delay is never inserted before the final decode: decode timestamps at decode time and a blocked sink postpones it (`src/codex.ts:492–495`), which would reset the age being measured.

## 5. Non-goals

Carried from round 1: routing criteria v3 (no new evidence; v2 failed predeclared gates); worker-level deadlines/retries in the product (evidence bar: a fresh gated live run reading WH-5 counters); transcript/stderr retention; seatbelt profile parser; moving oracles into `src/`; Jev 451 / dual / paired-cost authorization (external; standard-harness scope). New this round: merging the custom runner into the standard `executeAcceptance` flow; calibration or hosted orchestration in the custom runner; code predicates in round input (data-only until a round adjudicates one); report/seal/offline-diagnostic generators; cross-platform sandbox support (SBPL/`sandbox-exec` stays macOS-only, and CI coverage comes from fakes, not portation); any runner feature no adjudicated failure demands.

## 6. Rejected alternatives

Gate helpers without the runner (B — wiring risk stays where the loss happened); runner-inside-`executeAcceptance` (C — refactors frozen validated code); pluggable framework (D — one consumer); freezing profile text into the manifest (the exact v0.3.0 defect — profiles are regenerated in memory at execution); persistent profile artifacts with byte-equality (tautological against fresh generation and blind to same-path root replacement — identity checks catch both); exit-code-1/stderr-regex infrastructure detection (ambiguous and untrusted — the runner-owned outcome protocol replaces inference); runner-level `--deadline`/retry knobs (supervision stays parental); JSON-schema validation beyond the consumed fields (runtime asserts on what the runner reads bound the surface); delaying emission to test the age (measures the wrong clock — settlement delay after decode quiescence is the honest construction).

## 7. Test matrix

| Area | Checks |
| --- | --- |
| RT-1 prepare | roster validation (schema, `validateTask`, sizes); consumed-file baseline + HEAD freeze; local preflights (reference GREEN, broken-fixture RED, sentinel isolation) over the final roster; zero classifier requests / zero worker invocations; manifest emission |
| RT-1 execute gates | same-path-replaced and copied roots refused at identity check with zero further spend; infra failure (spawn error, signal, timeout, missing outcome) → integrity stop, no second spawn; ordinary assertion failure → continuation; grading modes (envelope+payload pass/fail, strict-equal, strict footer rejection) |
| RT-1 approval boundary | HEAD/dist mutation refusal; roster/task-file mutation refusal; relocated-manifest refusal; concurrent-claim exclusive-create failure |
| RT-1 lifecycle | SIGINT graceful; SIGTERM 143; exit 0/4/1; caps; oracle env allowlist (synthetic secret, `NODE_OPTIONS`/`NODE_PATH` absent) |
| Platform | all of the above on Linux via hermetic launcher/sandbox fakes; real-SBPL execution tests macOS-gated |
| TH-2 | spawn-count pin; `lastEventAgeMs > 0` in the forced-settlement-gap scenario |
| Regression | full `pnpm test` green; `pnpm run test:coverage` 80/80/80 on `dist/src/**` unchanged (test-only additions) |

## 8. Risks

The runner joins the baseline it helps validate — its manifest hashes the runner and primitives explicitly, so tooling drift re-freezes the round; that is what baseline hashing exists to catch. Identity checks depend on `realpath`/`dev`/`ino` stability between prepare and execute; a false mismatch fails closed (refuses to spend), the safe direction. The macOS-only `sandbox-exec` dependency is inherited; CI coverage of the gates comes from fakes, so a fake that diverges from real launcher behavior is the residual risk — bounded by keeping the fake at the launcher's process interface, not the sandbox's. The data-only roster removes the trusted-module bypass class but cannot make task *content* untrusted-safe; the manifest bounds and hashes it, and the operator approves the hash. TH-2's age assertion is bounded to one structurally deterministic scenario to keep the suite flake-free.

## 9. Codex review dispositions

Reviewed by codex `gpt-6-astra` on 2026-10-12 against the draft spec, the sealed report, the sealed tooling sources, and current source. Verdict: changes required. All eleven findings verified against source before adoption; none rejected. This revision incorporates all of them.

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | P1 | Zero-spend wrongly strengthened to zero subprocesses; sealed prepare ran behavioral sandbox preflights (`freeze.mjs:14–30`) the draft dropped | **Adopted** — §3.1: zero spend = zero classifier requests + zero worker invocations; local preflights retained; counters asserted separately |
| 2 | P1 | "Trusted exit semantics" had no implementation contract; assertion vs module-load both exit 1; `mustStop` is `:16` not `:15` | **Adopted** — §3.2(2): runner-owned outcome protocol (structured record via runner-provided path); spawn error/signal/timeout/missing/ambiguous = integrity stop; anchor fixed |
| 3 | P1 | An imported round module executes top-level code and can bypass every gate; "data plus predicates" enforces nothing | **Adopted** — §3.1: round input is a data-only JSON roster with declarative grading; no module import path exists |
| 4 | P1 | Approval boundary did not bind everything execution consumes (dist mutation, predicate files, transport files, evidence-root relocation) | **Adopted** — §3.4: explicit consumed-file hash list, runtime + evidence-root identity, four boundary negatives |
| 5 | P1 | Env scrub list conflated the CLI denylist boundary with the oracle allowlist boundary | **Adopted** — §3.5: two constructors kept separate; synthetic-secret and `NODE_OPTIONS`/`NODE_PATH` absence tests |
| 6 | P2 | Regeneration-equality was tautological (comparing two fresh generations) and blind to same-path root replacement; pre-oracle check alone is post-spend | **Adopted** — §3.2(1): identity checks before every reservation/launch; policy bytes generated in memory at execution, no persistent artifacts |
| 7 | P2 | Runner advertised calibration/hosted/Jev-dual policies its Laya-only custom scope contradicts | **Adopted** — §3.3/§1: custom runner scoped to local custom worker rosters; calibration/hosted promises removed |
| 8 | P2 | CI is `ubuntu-latest` running `test:coverage`; sandbox-exec tests would fail or be skipped wholesale | **Adopted** — §3.6/§7: hermetic launcher/sandbox fakes everywhere CI runs; real-SBPL tests macOS-gated |
| 9 | P2 | Delay-after-emission does not guarantee positive age; decode timestamps at decode and backpressure postpones it | **Adopted** — §4(2): gap constructed between decode quiescence and settlement, never before the final decode |
| 10 | P3 | Proposed trailer negative duplicates `live-acceptance.test.ts:1528/:1529` | **Adopted** — cut; deferred minor 2 closed as already covered |
| 11 | P3 | Worker-seatbelt "impossibility" overstated (filesystem-only profiles conceivable) | **Adopted** — §1 row 8 reworded as an explicit scope/evidence decision |

Confirmed sound by the same review: the two-workstream decision boundary, the approach table, TH-2 minor 1, the carried non-goals, and the no-`src/`-change boundary (no finding touched them).
