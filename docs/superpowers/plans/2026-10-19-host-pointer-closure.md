# Host-Pointer Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scrub a frozen 21-key list of host data/config/credential and action-capable pointer
variables at the worker boundary, attest the boundary generation as `envBoundary:
"host-pointers-v1"` on the worker receipt under the exact `instructionNote` conditional, and
align the boundary documentation — nothing else changes.

**Architecture:** One deletion pass inside the existing `workerEnvironment` copy plus one
case-insensitive name check for the two npm keys; one constant and one field assignment beside
`instructionNote` on the shared result construction; per-field whitelist admission in the two
harness projections; documentation passages rewritten in place. No new subsystem, validator,
config version, CLI flag, manifest axis, or journal key.

**Tech Stack:** TypeScript, Node >=24.5.0, pnpm 10.12.1, built-in `node:test`; existing fake
Codex executables, fault preload, and env-dumping worker helpers. No new dependencies.

**Spec:** [Host-Pointer Closure Design](../specs/2026-10-19-host-pointer-closure-design.md).
Read both documents before implementation. Source references below are baseline locations at
`29d7a55`; resolve symbols again if lines move.

**Status:** planning only, after three Astra review rounds closed at ACCEPT with zero findings
(spec §7). User plan review and execution-method choice are required before product edits. All
live authorities remain closed; this plan authorizes no live calls, no pushes, no
service/authentication/proxy changes.

## Global Constraints

- The scrub list is exactly the 21 keys of spec §3.1, frozen alphabetically in source, applied
  in `workerEnvironment` only; `subprocessEnvironment` and its `preflight` callers are
  untouched. `git grep` finds the list exactly once in `src/`.
- Case rule: only `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` match case-insensitively;
  every other key is scrubbed under its exact frozen spelling (so `ssh_auth_sock` stays present).
- Deletion semantics match the existing credential strip: own-property delete on the copy
  `workerEnvironment` already builds; `NODE_V8_COVERAGE` keeps its explicit `undefined`; the
  managed overrides `HOME`/`ZDOTDIR`/`CODEX_HOME`/`TURNHELM_MANAGED_CHILD` still win; `OPENAI_API_KEY`
  is never touched; no pattern, prefix, or partial matching.
- `envBoundary` is assigned beside `instructionNote` under the single `noteAppended` conditional
  (present on asynchronous spawn failure, absent on not-started / pre-abort / managed-home
  failure / synchronous spawn fault) and is validated everywhere as the exact whole-string
  literal `host-pointers-v1` — never a shape pattern; a non-matching, oversized, or
  trailing-newline value drops the field alone.
- No new config field, CLI flag, manifest axis, or key in the CLI-owned journals
  (`.turnhelm/routes.jsonl`, `.turnhelm/lifecycle.jsonl`); the evidence ledgers of custom-round
  and standard acceptance carry the field inside their existing record shapes, through both
  standard-acceptance stages (observed-record construction and `sanitizeEvidence`).
- Documentation passages must retain unlisted environment pointers (e.g. `AWS_CA_BUNDLE`) as
  documented residuals — never imply exhaustive environment-pointer closure — and state the
  consequence class (host configuration reachable only through a listed pointer must arrive via
  the task's own inputs).
- All documentation, comments, and commit messages are English. No compatibility adapters, no
  env knob, no unrelated cleanup, no weakened security/coverage gates. Tests use the existing
  fake-worker/fault helpers; no live provider request belongs to any task.
- Before execution, use the git-worktree skill to establish isolation from the documentation
  branch. Native implementation is recommended — the tasks share one contract; do not infer an
  execution-method choice from this plan.

## Review Focus

1. npm reads both config keys case-insensitively: lowercase, mixed-case, and simultaneous
   variants of both npm keys must be scrubbed, while a case variant of a no-case-rule key
   (`ssh_auth_sock`) still passes through. Pin in Task 1.
2. The two spawn-failure flavors differ: an asynchronous ENOENT (pipes present) carries BOTH
   `envBoundary` and `instructionNote`; a synchronous spawn fault carries neither — same for
   not-started, pre-abort, and managed-home failure. Pin in Task 2.
3. A tag value that is not exactly `host-pointers-v1` (future version, empty, oversized,
   trailing newline) drops the field alone in every projector — never coerced, never retained,
   and unselected keys keep being ignored. Pin in Tasks 3–4.
4. The scrub must not leak into `subprocessEnvironment` output (preflight/classifier paths) or
   mutate the parent CLI process environment; unlisted variables pass through byte-identically.
   Pin in Task 1.
5. Docs must keep the unlisted-pointer residual beside system files, hooks, `AGENTS.override.md`,
   and absolute reads, and the packaged-documentation assertions must follow the real text. Pin
   in Task 5.

## Phase 0: Documentation and API Discovery (completed for planning)

Three isolated `gpt-6-astra/high` review rounds through the local routing harness; verdict path
PROBLEMS(2 Important + 3 Minor) → PROBLEMS(2 Important + 2 Minor) → **ACCEPT, zero findings**
(spec §7). The parent verified every load-bearing finding against the code before revising. No
runtime test or provider call occurred during planning beyond the review workers themselves.

### Allowed existing APIs and patterns

| Source | Existing signature / copy-ready pattern |
| --- | --- |
| `src/codex.ts:72-90` | `subprocessEnvironment(env)` — read-only reference; unchanged |
| `src/codex.ts:92-111` | `workerEnvironment(env, homeDir)` — the single scrub edit site; spreads `subprocessEnvironment` then sets overrides |
| `src/codex.ts:10-40` | `WorkerResult`; `instructionNote?: string` at :34 — `envBoundary?: string` goes beside it |
| `src/codex.ts:57` | `SANDBOX_SEMANTICS_NOTE` export precedent for a frozen versioned constant |
| `src/codex.ts:354-357` | shared result construction; `if (noteAppended) result.instructionNote = "sandbox-semantics-v1"` — the co-location site |
| `src/codex.ts:774-783` | `noteAppended = true` at the stdin write, after the stdio-pipe check — why async spawn failure still attaches |
| `src/cli.ts:293` | explicit receipt construction: `if (worker.instructionNote !== undefined) workerReceipt.instructionNote = ...` — wire `envBoundary` beside it |
| `test/worker.test.ts:588-615` | hostile-home/XDG-passthrough spawned-worker test — update the XDG assertion, do not delete the test |
| `test/worker.test.ts:621-661` | surviving-descendant fixture (`runWorker` + descendant re-sampling) — extend with planted pointers |
| `test/codex.test.ts:31` | module export-surface assertion — gains the new constant |
| `test/cli.test.ts:130-170` | `FAULT_PRELOAD` fault modes; `"spawn"` throws synchronously inside patched `cp.spawn` — precedent for the new async flavor |
| `test/cli.test.ts:638-645, 668-677` | `faultEnv` helper; the synchronous spawn-fault test to extend |
| `test/cli.test.ts:497-511, 935, 1008, 1031, 1048` | receipt shape/key-array assertions that enumerate worker fields — each gains `envBoundary` where executed |
| `test/custom-round.ts:886-960` | `projectWorkerReceipt` per-field whitelist (`instructionNote` at :954 uses the shape pattern — `envBoundary` deliberately does not) |
| `test/live-acceptance.ts:122, 1315-1360, 2125-2139` | `SafeEvidence` observed record; `sanitizeEvidence` persistence filter; observed-record construction — both stages gain the field |
| `test/live-acceptance.ts:1118` | `INSTRUCTION_NOTE_PATTERN` — shape rule kept for the note; not copied for the tag |
| `README.md:295-340`, `.agents/skills/turnhelm-routing/SKILL.md:150-185` (+ `.claude` mirror) | the two boundary residual passages per document |
| `test/package.test.ts:215+` | packaged worker-boundary fragment assertions — update only what genuinely changes |

Discovery guards: the two harnesses' worker projections are separate contracts — do not
"unify" them. `projectWorkerReceipt` ignoring unselected keys is pinned behavior, not a gap.
The scrub list must exist exactly once in `src/` (spec §5.4) — one frozen array, no duplication
in comments elsewhere in `src/`.

---

## Task 1: Frozen host-pointer scrub in `workerEnvironment`

**Files:** Modify `src/codex.ts:92-111`. Test `test/codex.test.ts` (built-env unit tests),
`test/worker.test.ts` (spawned-worker and descendant fixtures).

**Interfaces:** `workerEnvironment(env, homeDir)` signature unchanged. A module-private frozen
`readonly string[]` of the 21 §3.1 keys in the spec's alphabetical order, plus the two-key
npm case check. No new exports (the tag constant arrives in Task 2).

- [ ] **Step 1: Failing tests.**
  - `test/codex.test.ts`: `workerEnvironment` called with all 21 keys planted (plausible values:
    socket paths for `SSH_AUTH_SOCK`/`DOCKER_HOST`, config paths otherwise) returns an env where
    every planted key is absent; planted `npm_config_userconfig`, `Npm_Config_GlobalConfig`, and
    both simultaneously are also absent; `ssh_auth_sock`, `AWS_CA_BUNDLE`, `XDG_SENTINEL`,
    `PATH`, `SHELL`, `TMPDIR`, `OPENAI_API_KEY`, `NODE_OPTIONS` pass through; the
    `HOME`/`ZDOTDIR`/`CODEX_HOME`/`TURNHELM_MANAGED_CHILD` overrides and the
    `subprocessEnvironment` strips still hold; `subprocessEnvironment` alone (no
    `workerEnvironment`) leaves all 21 keys in place.
  - `test/worker.test.ts`: through a real spawned fake worker that dumps `process.env`: all 21
    planted keys absent, npm lowercase/mixed/simultaneous variants absent, unlisted sentinels
    present, parent process env unchanged after the run; update (not delete) the existing
    XDG-passthrough assertion at :597-603 — `XDG_CONFIG_HOME` is now scrubbed, so the assertion
    flips to absence while the hostile-home discovery assertions stay; extend the
    surviving-descendant fixture (:621) so the descendant re-samples the planted pointers and
    sees the same absence after leader exit. Privacy canary (spec §5.5): the planted hostile
    values/socket paths appear nowhere in the run's receipt, stderr diagnostics, or
    `.turnhelm/routes.jsonl`.
- [ ] **Step 2: RED.** `pnpm run build && node --test dist/test/codex.test.js
  dist/test/worker.test.js` — new assertions fail on the passthrough status quo; unrelated
  failures are not a valid RED.
- [ ] **Step 3: Implement.** In `workerEnvironment`, after the existing overrides: delete each
  of the 21 frozen keys as own properties of the copy, then one bounded pass over
  `Object.keys(copy)` deleting names whose `toLowerCase()` equals `npm_config_userconfig` or
  `npm_config_globalconfig`. One code comment stating the §3.1 admission principle
  (data/config/credential discovery pointers and action-capable pointers; program pointers and
  `OPENAI_API_KEY` deliberately excluded; the frozen list is the contract; edits bump the tag).
- [ ] **Step 4: GREEN + regressions.** Both suites pass; full
  `node --test dist/test/worker.test.js dist/test/cli.test.js`; `git grep -c` the list body in
  `src/` is exactly one site.
- [ ] **Step 5: Commit.** `git diff --check`, then
  `feat: scrub frozen host-pointer variables from the worker environment` — Task 1 files only.

## Task 2: `envBoundary` attestation on `WorkerResult` and the CLI receipt

**Files:** Modify `src/codex.ts` (constant + `WorkerResult` + :354-357 assignment),
`src/cli.ts:293` (receipt). Test `test/cli.test.ts`, `test/codex.test.ts`, `test/worker.test.ts`.

**Interfaces:** `export const ENV_BOUNDARY_TAG = "host-pointers-v1"` in `src/codex.ts`
(consumed by Tasks 3–4). `WorkerResult` gains `envBoundary?: string`; the CLI receipt's
`worker` object carries it exactly when `instructionNote` is carried.

- [ ] **Step 1: Failing tests.** In `test/cli.test.ts`: the receipt carries
  `envBoundary: "host-pointers-v1"` beside `instructionNote` on completed, failed, and cancelled
  executed workers (extend the existing shape assertions at :497-511, :935, :1031, :1048);
  a new `spawn-async` fault mode — in `FAULT_PRELOAD`, when the patched `cp.spawn` sees the
  worker argv (`codex ... exec`), return `real("<missing-binary>", args, options)` so pipes
  exist and ENOENT arrives asynchronously — asserts BOTH fields present on that receipt;
  the synchronous spawn-fault test (:668), the managed-home failure tests (:646, :661), and the
  not-started receipt (:1008) assert NEITHER field. In `test/codex.test.ts`: the export-surface
  list (:31) gains `ENV_BOUNDARY_TAG`. In `test/worker.test.ts`: an executed-worker result
  object carries both fields.
- [ ] **Step 2: RED.** Focused run fails on the missing constant/field only.
- [ ] **Step 3: Implement.** Add the constant, the `WorkerResult` field (comment: mechanism
  attestation in the `instructionNote` honesty class, exact-literal generation), assign
  `result.envBoundary = ENV_BOUNDARY_TAG` inside the existing `if (noteAppended)` block, and
  mirror the `src/cli.ts:293` wiring one line beside `instructionNote`. Nothing else.
- [ ] **Step 4: GREEN + regressions.** `node --test dist/test/cli.test.js
  dist/test/codex.test.js dist/test/worker.test.js`; confirm the key-array assertions enumerate
  the new field on executed paths only.
- [ ] **Step 5: Commit.** `feat: attest host-pointer boundary generation on worker receipts`.

## Task 3: custom-round `projectWorkerReceipt` whitelist

**Files:** Modify `test/custom-round.ts:886-960`. Test `test/custom-round.test.ts:1500-1562`.

**Interfaces:** Consumes `ENV_BOUNDARY_TAG` from `../src/codex.js`. `projectWorkerReceipt`
admits `envBoundary` per-field: present iff the value is exactly `ENV_BOUNDARY_TAG`.

- [ ] **Step 1: Failing tests.** `FULL_WORKER`/`FULL_PROJECTION` gain
  `envBoundary: "host-pointers-v1"`; drop cases each drop the field alone while every other
  field survives: `"host-pointers-v2"`, `""`, a 4 KiB value, and `"host-pointers-v1\n"`
  (trailing newline); a receipt carrying an unselected extra key is still ignored unchanged;
  the not-started projection gains nothing.
- [ ] **Step 2: RED.** `pnpm run build && node --test dist/test/custom-round.test.js` — the
  new FULL_PROJECTION field and drop cases fail.
- [ ] **Step 3: Implement.** Add optional `envBoundary?: string` to the two record types
  (:886, :925), destructure it (:929), and admit it with `=== ENV_BOUNDARY_TAG` — deliberately
  not `INSTRUCTION_NOTE_PATTERN`-style shaping (spec §3.2).
- [ ] **Step 4: GREEN + regress.** Full custom-round suite.
- [ ] **Step 5: Commit.** `test: admit envBoundary through the custom-round receipt whitelist`.

## Task 4: standard-acceptance observed record, both stages

**Files:** Modify `test/live-acceptance.ts:122` (type), `:2125-2139` (construction),
`:1315-1360` (`sanitizeEvidence`). Test `test/live-acceptance.test.ts` (extend the
:1595-1645 retention/drop block).

**Interfaces:** Consumes `ENV_BOUNDARY_TAG`. `SafeEvidence`'s observed phase gains optional
`envBoundary?: string`, extracted from a non-`not-started` worker receipt when the value is
exactly the tag, and retained through `sanitizeEvidence` with the same exact-literal rule.

- [ ] **Step 1: Failing tests.** Beside the existing `instructionNote` retention tests: a valid
  tag is retained on the observed record and survives the persisted line; empty,
  `"host-pointers-v2"`, oversized, and trailing-newline values drop the field alone at
  construction and, when injected raw, at `sanitizeEvidence`; a `not-started` worker never
  gains the field; an observed record that already carries other fields keeps them.
- [ ] **Step 2: RED.** Focused live-acceptance suite fails on the missing field only.
- [ ] **Step 3: Implement.** Type field at :122; extraction guarded by
  `worker.status !== "not-started" && worker.envBoundary === ENV_BOUNDARY_TAG` in the
  :2125-2139 block; retention with the identical check inside `sanitizeEvidence` (:1355
  pattern). No journal shape outside the existing evidence ledger changes.
- [ ] **Step 4: GREEN + regressions.** Full live-acceptance suite; custom-round suite still
  green (it imports from this module).
- [ ] **Step 5: Commit.** `test: carry envBoundary through standard-acceptance evidence stages`.

## Task 5: Boundary documentation alignment

**Files:** Modify `README.md:295-340` (both residual passages), `.agents/skills/turnhelm-routing/SKILL.md:150-185`
and the `.claude/skills/turnhelm-routing/SKILL.md` mirror (identical edit). Test
`test/package.test.ts` (boundary fragments), `test/init.test.ts` (only if its packaged-skill
assertions reference changed text).

**Interfaces:** Consumes the §3.1 list and tag wording; no code.

- [ ] **Step 1: Failing tests.** Update/add `test/package.test.ts` fragments asserting the
  packed README and skill state: the listed host-pointer variables are scrubbed (naming the
  tag `envBoundary: "host-pointers-v1"` and the npm case rule), and the residual list retains
  unlisted environment pointers such as `AWS_CA_BUNDLE` beside system files, hooks,
  `AGENTS.override.md`, and absolute reads. Run to see them fail against current text.
- [ ] **Step 2: Implement.** Rewrite the two passages per document: the worker env paragraph
  gains the scrub sentence (list families + tag + case rule + consequence class: host
  configuration reachable only through a listed pointer must arrive via the task's own
  inputs); each residual sentence keeps the unlisted-pointer residual explicit. Keep the
  `.claude` mirror byte-identical to `.agents`.
- [ ] **Step 3: Verify.** `pnpm run build && node --test dist/test/package.test.js
  dist/test/init.test.js`; README/skill alignment re-read.
- [ ] **Step 4: Commit.** `docs: align boundary docs with the host-pointer scrub and tag`.

## Task 6: Full regression sweep and closure

**Files:** None (verification only; any defect fix lands in the owning task's files and commit).

- [ ] **Step 1: Focused suites.** `pnpm run build && node --test dist/test/codex.test.js
  dist/test/worker.test.js dist/test/cli.test.js dist/test/custom-round.test.js
  dist/test/live-acceptance.test.js` — all green.
- [ ] **Step 2: Full gate.** `pnpm test` and stock `pnpm test:coverage` with the existing 80%
  gates; dependency audit (`pnpm audit --audit-level=high` or the repo's established command);
  `git diff --check`.
- [ ] **Step 3: Scope checks.** `git grep` the 21-key list body across `src/` — exactly one
  site; no new key in `.turnhelm/routes.jsonl`/`lifecycle.jsonl` writers; `subprocessEnvironment`
  unit tests byte-identical to baseline expectations; no config/flag/manifest surface added
  (`git diff --stat` review against this plan's file list).
- [ ] **Step 4: Report.** Summarize verdicts per spec §5 criteria 1–6; anything not green is
  reported as an open defect with its failing output, never silently patched around.
