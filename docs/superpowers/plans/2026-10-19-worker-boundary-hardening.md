# Worker Boundary Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the worker boundary along the three spec axes — hermetic `HOME`/`ZDOTDIR`, a fixed
versioned sandbox-semantics instruction note, and an opt-in stall-abort watchdog that maps to the
existing unjudged-timeout outcome — without changing routing, grading, manifest semantics of
standard acceptance, `workerExit` rules, or any default behavior.

**Architecture:** One env assignment and one fixed stdin suffix at the existing spawn boundary; one
timer inside `executeWorker` that starts the existing owned TERM→KILL ladder; one roster field plus
one CLI flag; two bounded receipt fields flowing through the existing per-field projections. No new
subsystem, validator, config version, or manifest version.

**Tech Stack:** TypeScript, Node >=24.5.0, pnpm 10.12.1, built-in `node:test`; existing fake Codex
executables, fake classifiers and sandbox helpers. No new dependencies.

**Spec:** [Worker Boundary Hardening Design](../specs/2026-10-19-worker-boundary-hardening-design.md).
Read both documents before implementation. Source references below are baseline locations at
`2ddb042`; resolve symbols again if lines move.

**Status:** planning only, after three Astra review rounds (spec §7). User plan review and
execution-method choice are required before product edits. All live authorities remain closed; this
plan authorizes no live calls, no pushes, no service/authentication/proxy changes.

## Global Constraints

- Only `HOME` and `ZDOTDIR` change in the worker environment; the existing `subprocessEnvironment`
  filtering (credentials, `BASH_ENV`/`ENV`, coverage suppression) and `CODEX_HOME`/
  `TURNHELM_MANAGED_CHILD` overrides remain intact. No env scrubbing beyond the two.
- The worker instruction is exactly `task + "\n\n" + NOTE`, appended after `validateTask`, never
  inside it; the classifier request and `routes.jsonl` hash/length still describe the bare task; the
  note's final wording is frozen in the constant before the byte-exact tests are written.
- The watchdog is opt-in (`--stall-abort-ms`, 5000–3600000; roster `stallAbortMs`), arms only after
  the first decoded frame, never fires with zero frames or after terminal event/shutdown/settlement,
  extends its deadline as frames decode, loses precedence to a caller signal, and drives the
  existing `beginShutdown` TERM→KILL ladder unchanged. The run settles cancelled with
  `abortReason: "stall"`; `workerExit` is untouched (143/137-typical exit, no normalization).
- `stall-abort` joins `LifecycleKind` and the shared `LIFECYCLE_KINDS` whitelist in the same change;
  recording stays conditional on `--lifecycle`.
- Custom-round: `stallAbortMs` validates at prepare (roster and manifest re-verification), freezes
  into the manifest, passes as the CLI flag on both transports; a lone attributable stall receipt
  yields the unjudged `timeout` outcome at the existing decision position; `projectWorkerReceipt`
  gains `instructionNote`/`abortReason` per-field with unselected keys still ignored (no new
  validator).
- Standard live acceptance: no new prepare flag, no manifest/case-schema change, no stall flag ever
  passed; the observed record gains only the optional bounded `instructionNote`.
- `test/live.integration.ts` flags and USAGE string are unchanged.
- All documentation, comments, code descriptions and commit messages are English. No compatibility
  adapters, no default-on behavior, no unrelated cleanup, no weakened security/coverage gates.
- Before execution, use the git-worktree skill to establish isolation from the documentation branch.
  Native implementation is recommended — the tasks share one contract; do not infer an
  execution-method choice from this plan.

## Review Focus

1. The watchdog must not fire on zero decoded frames, after a terminal event, or after shutdown
   starts, and a caller signal arriving first must keep precedence with no stall reason recorded.
   Pin in Task 3.
2. The note must not touch validation order or rejection semantics, and the classifier/journal must
   still see bare-task bytes. Pin in Task 2.
3. The stall→timeout mapping sits at the existing decision position: no oracle, no contract check,
   roster continues; a stall receipt that is not lone/attributable follows existing stop rules.
   Pin in Task 4.
4. Env change is exactly two variables; `XDG_CONFIG_HOME` and friends still pass through; the
   managed home's teardown is unchanged. Pin in Task 1.
5. A `stall-abort` lifecycle event must survive both receipt projection and journal fallback; a
   not-started worker never gains fields or a timeline. Pin in Tasks 3–5.

## Phase 0: Documentation and API Discovery (completed for planning)

Three isolated `gpt-6-astra/high` review rounds through the local routing harness; verdict path
PROBLEMS(6 Important + 1 Minor) → PROBLEMS(1 Important + 3 Minor) → **ACCEPT, zero findings**
(spec §7). The parent verified load-bearing claims against the code. No runtime test or provider
call occurred during planning.

### Allowed existing APIs and patterns

| Source | Existing signature / copy-ready pattern |
| --- | --- |
| `src/codex.ts:44-55` | `buildWorkerArgs(decision, write, schemaPath)`; argv ends with `-` (stdin task) |
| `src/codex.ts:57-90` | `subprocessEnvironment(env)` filtering; `workerEnvironment(env, root, homeDir)` sets `CODEX_HOME`/`ZDOTDIR` — the single edit site for Task 1 |
| `src/codex.ts:129-161` | `createWorkerHome`/`destroyWorkerHome`; mkdtemp home with auth symlink and staged schema |
| `src/codex.ts:178-262` | `executeWorker(decision, task, options)`; state vars `progressEvents`/`lastEventAt` already track decoded frames |
| `src/codex.ts:299-301,417-441` | `completedEligible()`; `beginShutdown()` TERM→poll→KILL ladder with `dischargeShutdown` — reused unchanged by the watchdog |
| `src/codex.ts:459-477` | `recordFailure` cause classes; `onAbort` sets `cancelled` — the watchdog mirrors the abort settle path with `abortReason` |
| `src/cli.ts:44-70,86-92,139` | flag `parse` (usage exit 2 pattern), `workerExit` rules (untouched), `runCommand` |
| `src/cli.ts:226-242` | explicit receipt construction — where `instructionNote`/`abortReason` are wired onto `worker` |
| `src/task.ts:12-29` | `checkTask`/`validateTask` — read-only reference; no edits |
| `src/lifecycle.ts:8-24` | `LifecycleKind` union and `LifecycleRecorder.record` |
| `test/custom-round.ts:245-258,421-447,632-638,722-723` | `RosterCase`; strict `caseKeys` (+ optional `outputSchema` precedent at 422); `deadlineMs` validation pattern (int, 5000–3600000); manifest freeze and re-verification sites |
| `test/custom-round.ts:874-933` | `WORKER_STATUSES`; `projectWorkerReceipt` per-field whitelist — add the two fields here |
| `test/custom-round.ts:1152-1162` | case CLI argv build for both transports (`--lifecycle ... --` ) — insert `--stall-abort-ms` here |
| `test/custom-round.ts:1240-1366` | case decision order; `observation.timedOut` gates the unjudged `timeout` outcome append — the mapping site |
| `test/live-acceptance.ts:1072-1089,1112,1219,1265` | failure-only `projectWorkerFailure` (gains nothing); `LIFECYCLE_KINDS` whitelist shared by receipt and journal projection — add `stall-abort` here |
| `test/live-acceptance.ts:122` | `SafeEvidence` observed record — add optional `instructionNote` |
| `test/live.integration.ts:9-38` | strict prepare flags; deliberately unchanged |
| `test/worker.test.ts`, `test/cli.test.ts`, `test/custom-round.test.ts`, `test/live-acceptance.test.ts` | existing fake-worker helpers, receipt/env assertions, both-transport and stop tests — extend, do not replace |

Discovery guards: the two harnesses' worker projections are separate contracts (spec §3.4) — do not
"unify" them. `projectWorkerReceipt` ignoring unselected keys is pinned behavior
(`test/custom-round.test.ts:1425-1427`), not a gap to fix. The outer supervisor's SIGINT→SIGTERM
ladder (runner→CLI) is a different ladder from `executeWorker`'s TERM→KILL; never conflate them.

---

## Task 1: Hermetic worker HOME/ZDOTDIR

**Files:** Modify `src/codex.ts:77-90`. Test `test/worker.test.ts` (environment assertions).

**Interfaces:** `workerEnvironment(env, root, homeDir)` signature unchanged; `HOME: homeDir`,
`ZDOTDIR: homeDir` replace the project-`.turnhelm` ZDOTDIR target. Nothing else in the env changes.

- [ ] **Step 1: Failing tests.** Assert the spawned fake worker sees `HOME` and `ZDOTDIR` equal to
  the managed home and equal to `CODEX_HOME`; assert `XDG_CONFIG_HOME` (when planted in the parent
  env) still passes through; assert credential/`BASH_ENV`/`ENV` stripping and
  `TURNHELM_MANAGED_CHILD` overrides still hold; assert the parent process env is untouched and the
  home is removed after settlement. Add a hostile-host synthetic check: a descendant resolving
  `$HOME/.config/...`, `$HOME/.agents/...`, `$HOME/.gitconfig` reads inside the managed tree only.
- [ ] **Step 2: RED.** `pnpm run build && node --test dist/test/worker.test.js` — new assertions
  fail on the host-HOME status quo; unrelated failures are not a valid RED.
- [ ] **Step 3: Implement.** Two assignments in `workerEnvironment`; update its comment to the
  scoped claim (HOME/ZDOTDIR-derived discovery; overrides and system files remain residuals). No
  other env surgery.
- [ ] **Step 4: GREEN + regressions.** Full `node --test dist/test/worker.test.js dist/test/cli.test.js`;
  confirm no staged dotfiles appear in the managed home and teardown coverage still passes.
- [ ] **Step 5: Commit.** `git diff --check`, dependency audit, then
  `feat: redirect worker HOME and ZDOTDIR to the managed home` — Task 1 files only.

## Task 2: Sandbox-semantics instruction note

**Files:** Modify `src/codex.ts` (constant + stdin write site), `src/cli.ts:226-242` (receipt).
Test `test/worker.test.ts`, `test/cli.test.ts`.

**Interfaces:** Exported constant `SANDBOX_SEMANTICS_NOTE` (version tag `sandbox-semantics-v1`,
final wording frozen from spec §3.2 before tests are written). `WorkerResult` gains optional
`instructionNote?: string`; the receipt `worker` object carries it on every executed-worker path
where the note was appended; `not-started` workers never carry it.

- [ ] **Step 1: Failing tests.** Byte-exact stdin assertion: the fake worker receives
  `task + "\n\n" + SANDBOX_SEMANTICS_NOTE` for argument and stdin transports; oversize/blank/
  continuation-only/NUL tasks still reject with unchanged messages before any append; the
  classifier fixture's request body and the `routes.jsonl` hash/length still describe the bare
  task; the receipt carries `instructionNote: "sandbox-semantics-v1"` on completed, failed, and
  cancelled executed workers and nothing on `not-started`.
- [ ] **Step 2: RED.** Focused run fails on missing note/tag only.
- [ ] **Step 3: Implement.** Append after validation at the existing stdin write; thread the tag
  through `WorkerResult` into the explicit receipt construction. No classifier, journal, or payload
  changes.
- [ ] **Step 4: GREEN + regressions.** Worker/cli suites plus `test/codex.test.ts` module surface;
  confirm framing, schema-on/off, and terminal-status tests unchanged.
- [ ] **Step 5: Commit.** `feat: append fixed sandbox-semantics note to the worker instruction`.

## Task 3: Opt-in stall-abort watchdog

**Files:** Modify `src/codex.ts` (watchdog in `executeWorker`), `src/cli.ts` (flag parse + option
pass), `src/lifecycle.ts:8` (`LifecycleKind`). Test `test/worker.test.ts`, `test/cli.test.ts`,
`test/lifecycle.test.ts`.

**Interfaces:** `executeWorker` options gain optional `stallAbortMs?: number`. CLI parses
`--stall-abort-ms <integer>` (5000–3600000; missing value, non-integer, out-of-range, duplicate →
usage exit 2). On fire: one `stall-abort` lifecycle record, `beginShutdown()` unchanged, settle as
a cancelled run with `abortReason: "stall"` on the worker result; no new status, failure class, or
exit normalization.

- [ ] **Step 1: Failing tests.** Fake-worker timelines: (a) silence ≥ threshold after a first
  decoded frame fires — lifecycle shows `stall-abort` then the existing `shutdown-term`/
  `shutdown-kill` sequence, result is cancelled with `abortReason: "stall"`, `ownedShutdown: true`,
  and `progressEvents`/`lastEventAgeMs` retained; (b) zero decoded frames never fires (run ends by
  caller deadline as today); (c) a later frame extends the deadline; (d) no firing after terminal
  event, shutdown start, or settlement; (e) a caller signal during armed silence wins precedence and
  records no stall reason; (f) CLI exit follows `workerExit` unchanged (143/137-typical). Flag
  matrix per interface above. Lifecycle round-trip: a `stall-abort` event survives the recorder
  snapshot and journal line.
- [ ] **Step 2: RED.** Focused run fails on missing flag/watchdog only.
- [ ] **Step 3: Implement.** One timer: armed at the first decoded frame, `lastEventAt` refresh
  re-arms it, cleared in `finish`; the fire path records the event, sets the stall reason, and
  calls the existing `beginShutdown`/settle path — no ladder duplication. `stall-abort` joins
  `LifecycleKind`.
- [ ] **Step 4: GREEN + regressions.** Worker/cli/lifecycle suites; re-run the cancellation,
  sticky-failure, sink-error, and teardown cases to prove no precedence shift.
- [ ] **Step 5: Commit.** `feat: opt-in stall-abort watchdog on the owned shutdown ladder`.

## Task 4: Custom-round roster field, mapping, and projection

**Files:** Modify `test/custom-round.ts` (`RosterCase`, `caseKeys`, validation, manifest freeze and
re-verification, argv build 1152-1162, decision-order mapping, `projectWorkerReceipt`,
`LIFECYCLE_KINDS`-equivalent whitelist if separate). Test `test/custom-round.test.ts`.

**Interfaces:** Optional case field `stallAbortMs` (int 5000–3600000, validated at roster parse and
manifest re-verification, frozen with the case). Both transports append
`["--stall-abort-ms", String(value)]` when present. A lone attributable receipt with
`worker.abortReason === "stall"` produces `outcome: "timeout"` at the existing decision position —
no oracle, no contract check, roster continues; otherwise existing stop rules apply.
`projectWorkerReceipt` gains per-field `instructionNote` (version-tag string) and `abortReason`
(`"stall"` only); unselected keys keep being ignored.

- [ ] **Step 1: Failing tests.** Roster validation accepts/rejects the field (missing value,
  non-integer, out-of-range, duplicate key); manifest freeze + replay-refusal on mismatch; both
  transports carry the flag; a stall-aborted lone attributable receipt appends the unjudged
  `timeout` case record and the roster continues; a stall receipt alongside a second receipt or an
  unattributable worker follows existing stop rules; projection retains/drops the two fields on
  malformed/out-of-enum input; the `completed` reconciliation counts a stall-timeout in `timedOut`.
- [ ] **Step 2: RED.** Custom-round suite fails on the missing field/mapping only.
- [ ] **Step 3: Implement.** Mirror the `outputSchema` optional-key precedent at `caseKeys`; follow
  the `deadlineMs` validation pattern; insert the mapping where `observation.timedOut` already
  decides the unjudged outcome; extend the projection whitelist per-field.
- [ ] **Step 4: GREEN + regressions.** Full custom-round suite including stop-order, tree-drift,
  both-transport, and exit-code semantics (a stall case contributes exit `4`, never `0`).
- [ ] **Step 5: Commit.** `feat: freeze and honor stallAbortMs in custom rounds`.

## Task 5: Standard-acceptance evidence retention and shared whitelist

**Files:** Modify `test/live-acceptance.ts` (`LIFECYCLE_KINDS:1112`, observed record `:122`,
receipt extraction site). Test `test/live-acceptance.test.ts`; verify
`test/live.integration.test.ts`/`test/live.integration.ts` unchanged.

**Interfaces:** `LIFECYCLE_KINDS` admits `stall-abort` (receipt and journal projection paths both
consume the one set). The observed record gains optional `instructionNote?: string` extracted from
the lone receipt's worker object for every executed worker regardless of status; `abortReason` is
not extracted; `workerFailure` gains nothing; no manifest, prepare-flag, or case-schema change.

- [ ] **Step 1: Failing tests.** A `stall-abort` lifecycle event in a receipt timeline and in a
  journal fallback both survive projection (previously the whole timeline dropped); observed
  records retain `instructionNote` for completed, failed, and cancelled workers and omit it for
  `not-started`; unknown worker keys still degrade per existing extraction rules; strict nested
  projection validators still reject unknown keys in a present projection; a privacy canary in
  note-adjacent fields never reaches evidence beyond the defined fields.
- [ ] **Step 2: RED → implement → GREEN.** Whitelist + one extraction field; no validator is added.
- [ ] **Step 3: Commit.** `test: retain instruction note and stall lifecycle evidence in acceptance`.

## Task 6: Documentation and packaged-contract alignment

**Files:** Modify `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (and the `.claude` mirror
if the repository carries one); test `test/package.test.ts`, `test/init.test.ts` only where
packaged-text assertions genuinely change.

- [ ] **Step 1:** Document the scoped hermetic-HOME guarantee and its residuals, the note and its
  version tag (instruction surface is now task + fixed note; classifier/routes still see the bare
  task), and stall-abort semantics (opt-in, adaptive, unjudged-timeout mapping, exit behavior).
  Keep README and skill passages aligned; update the residual list so the two closed residuals move
  out of the open list and the remaining ones (override env vars, system files, admin hooks,
  `AGENTS.override.md`, absolute host reads) stay stated.
- [ ] **Step 2:** Update packaged/install assertions reached by the new text; do not weaken gates.
- [ ] **Step 3:** Full sweep: `pnpm run build`, typecheck, full `pnpm test`, stock
  `pnpm test:coverage` with the existing 80% gates, dependency audit, `git diff --check`, and a
  scoped-diff review confirming spec §4/§5 coverage. Commit `docs: hermetic home, sandbox note, and
  stall abort boundaries`.

## Verification summary (all offline)

Spec §5 criteria map to tasks as: 1→Task 1, 2→Tasks 2+5, 3→Tasks 3+4, 4→Tasks 3+4, 5→Task 4,
6→Tasks 2+5, 7→Task 6 final sweep. No live command belongs to this plan; any future live
diagnostic needs a fresh finite manifest/SHA approval (spec §6).
