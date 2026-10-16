# Worker Instruction Boundary and Explicit Output Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Authorization note:** the spec's status banner applies — this plan is written, not executed. Implementation
> begins only on the user's explicit go-ahead, on a fresh feature branch; this docs branch stays docs-only.

**Goal:** the routed worker executes under a per-run managed `CODEX_HOME` (credential symlink + staged schema
only) with host codex config and execpolicy rules ignored by argv, `--output-schema` becomes a staged opt-in
passthrough, and the receipt attests the mechanism set — closing the RCA §3B instruction channel behind the
33-rollout failure class and the RCA §6.4 output-contract gap.

**Architecture:** boundary mechanics live in `src/codex.ts` (`buildWorkerArgs` flags; `workerEnvironment` takes
the managed home; `executeWorker` creates/destroys the home around the existing settlement lifecycle, fail-closed
on creation failure); schema validation and staging happen at the CLI input boundary (`src/cli.ts`) before
classification; preflight gains the capability tokens (`src/preflight.ts`). The payload classifier, harnesses,
routing, and journal are untouched.

**Tech Stack:** TypeScript (Node ≥24.5, strict), `node:test` via `pnpm test`, existing fake-codex scenario table
in `test/worker.test.ts`, existing CLI e2e patterns in `test/cli.test.ts`, fake-help fixtures in
`test/preflight.test.ts`.

**Spec:** `docs/superpowers/specs/2026-10-16-worker-boundary-and-output-contract-design.md` — the plan argues
from it; read both.

## Global Constraints

- No functional change outside `src/codex.ts`, `src/cli.ts`, `src/preflight.ts`, and their tests
  (spec §2); `test/custom-round.ts`, `test/live-acceptance.ts`, `src/payload.ts`, routing, config, journal
  untouched — the new receipt field is ignored by harness projections by construction.
- Settlement semantics, ladder timings, PE-1 payload classification, env stripping, `ZDOTDIR` redirect, frozen
  failure taxonomy, 8192-byte task bound: inherited unchanged (spec §2).
- Zero paid calls; all tests offline with fake codex and fake help (spec §4). No
  `--dangerously-bypass-hook-trust`, ever (spec §5).
- Every changed line traces to the spec; comments match the files' dense comment style; docs and comments in
  English.
- Conventional Commits; do not merge to main (user merges personally).

## Review Focus

1. **Cleanup ordering and the credential symlink** — removal happens only after settlement discharge on every
   path, unlinks (never follows) the symlink, and leaves the real `auth.json` untouched → pinned in Task 2.
2. **Fail-closed, no inherited-home fallback** — `mkdtemp` or symlink-setup failure yields the `spawn` failure
   class; an inherited `CODEX_HOME` value is never forwarded → pinned in Task 2.
3. **Schema staging TOCTOU** — mutating/replacing/deleting/symlink-swapping the caller's file after validation
   cannot change the bytes the worker reads → pinned in Task 3.
4. **Mode is framing-only** — valid JSON of the wrong shape still classifies `strict` with a schema present →
   pinned in Task 4.
5. **Pre-spend credential refusal** — no discoverable credential source means exit before classification, no
   journal append, no receipt → pinned in Task 4.

---

### Task 1: Preflight capability gate

**Files:**
- Modify: `src/preflight.ts` (`REQUIRED_CONTROLS`, line 13)
- Test: `test/preflight.test.ts` (fake-help fixtures)

**Interfaces:**
- `REQUIRED_CONTROLS` becomes `["--json", "--ephemeral", "--sandbox", "-", "--ignore-user-config",
  "--ignore-rules", "--output-schema"]` — exact whitespace tokens of `codex exec --help` (E3 discipline).
  `MIN_VERSION` stays `[0, 160, 0]`; the controls are the floor (spec WB-3).

- [ ] **Step 1: RED** — extend the fake-help fixtures with one help text missing exactly one of the three new
  tokens; assert `inspectCodex` returns `ok: false` for each, and `ok: true` only when all seven controls match
  the current list.
- [ ] **Step 2: GREEN** — apply the `REQUIRED_CONTROLS` change; pin the full control list in one assertion.
- [ ] **Step 3:** `pnpm test -- dist/test/preflight.test.js` green; commit
  `feat: require codex boundary controls in preflight`.

### Task 2: Managed worker home and argv isolation (`src/codex.ts`)

**Files:**
- Modify: `src/codex.ts` (`buildWorkerArgs`, `workerEnvironment`, `executeWorker`, `WorkerResult`)
- Test: `test/worker.test.ts` (scenario table + fake-codex shim; new environment-capture knobs)

**Interfaces:**
- `buildWorkerArgs(decision, write, schemaPath?: string): string[]` — appends `--ignore-user-config`,
  `--ignore-rules`; appends `--output-schema <path>` only when a staged schema path is supplied (spec WB-1, OC-1).
- `executeWorker` options gain `schemaBytes?: Buffer` (already-validated bytes; staging is CLI-side validation +
  worker-side write, so the validated buffer crosses the boundary once).
- New internal helpers in `src/codex.ts`: `createWorkerHome(env)` → `{ dir, authLinked }` using
  `mkdtemp(join(tmpdir(), "turnhelm-worker-"))`, an optional `auth.json` symlink to the parent-derived source
  (parent `CODEX_HOME` when set, else `~/.codex/auth.json`, only when it exists), and a staged
  `output-schema.json` written from `schemaBytes`; and `destroyWorkerHome(dir)` — `rmSync(dir, { recursive: true,
  force: true })` invoked only after settlement discharge (spec WB-2).
- `WorkerResult` gains `codexHomeManaged: true` (literal, executed workers only).
- `workerEnvironment(env, root, homeDir)` sets `CODEX_HOME: homeDir`, overriding any inherited value.

- [ ] **Step 1: RED** — environment-capture scenario: the fake codex shim records its `env.CODEX_HOME` and the
  managed home's directory listing to a side file. Assert: `CODEX_HOME` points at a fresh directory under
  `tmpdir()`; the listing contains exactly `auth.json` (when a source auth file fixture exists) plus
  `output-schema.json` (when schema bytes are supplied) and nothing otherwise; an inherited `CODEX_HOME` value
  never appears.
- [ ] **Step 2: RED** — lifecycle scenarios: after `completed`, `failed`, `cancelled`, and spawn-error
  settlements the managed directory no longer exists; a linger knob keeps the fake alive post-settlement-start
  to prove removal waits for owned-shutdown discharge and `closed`.
- [ ] **Step 3: RED** — fail-closed: inject `mkdtemp` failure (monkey-patched `fs` via the test's module seam or
  a poisoned `TMPDIR`); assert the existing `spawn` failure class and that no run starts with an inherited home.
  Symlink-discipline unit test: write through an `auth.json` symlink lands in the target file;
  `destroyWorkerHome` on a dir containing the symlink leaves the target untouched.
- [ ] **Step 4: GREEN** — implement `createWorkerHome`/`destroyWorkerHome`, wire into `executeWorker` (create
  before spawn, destroy in the settle path after discharge, all paths including mid-setup failure), add the argv
  flags, set `codexHomeManaged: true` on executed results.
- [ ] **Step 5:** re-pin the argv/env tests that asserted the pre-boundary vector (spec §4 item 8 — rewritten,
  not deleted). `pnpm test` green; commit `feat!: isolate worker instruction context behind a managed codex home`.

### Task 3: `--output-schema` CLI flag, validation, and staging

**Files:**
- Modify: `src/cli.ts` (`parse` allowed-flags for `run`, validation, `runCommand` wiring)
- Test: `test/cli.test.ts`

**Interfaces:**
- `run` accepts `--output-schema <path>` in both token and `=` forms, matching `--project` handling; duplicates
  rejected (spec OC-1).
- Validation at the input boundary, before classification: regular file (open with `O_NOFOLLOW`), ≤ 64 KiB,
  valid UTF-8, `JSON.parse` result is a plain object. Rejection: usage error, exit 2, fixed diagnostic, no
  journal, no receipt.
- On success the read bytes are passed to `executeWorker` as `schemaBytes`; the worker stages them inside the
  managed home (Task 2) and the argv points there — the caller's path is never forwarded.

- [ ] **Step 1: RED** — parse tests: valid file → run proceeds with staging (fake worker asserts the staged
  file's bytes); missing file, symlink, oversized (> 64 KiB), invalid UTF-8, non-object JSON (bare `true`,
  array, number) → exit 2, exact fixed diagnostic, empty journal, no receipt on stderr.
- [ ] **Step 2: RED** — TOCTOU: the test mutates, replaces, deletes, and symlink-swaps the caller's file after
  CLI validation begins (a slow-reader seam or pre-spawn hook in the fake); the staged bytes the worker reads
  remain the validated ones in all four cases.
- [ ] **Step 3: GREEN** — implement parsing, validation, and `schemaBytes` wiring.
- [ ] **Step 4:** `pnpm test` green; commit `feat: add staged opt-in output schema passthrough`.

### Task 4: Credential refusal, receipt attestation, framing regression

**Files:**
- Modify: `src/cli.ts` (pre-classification credential refusal; receipt `worker.codexHomeManaged`)
- Test: `test/cli.test.ts`, `test/payload.test.ts` (one added regression)

**Interfaces:**
- Credential discovery helper in `src/codex.ts` (`discoverWorkerCredential(env)`): the parent-derived auth file
  path when it exists, else `OPENAI_API_KEY` presence in the worker-bound environment. `runCommand` refuses
  before classification — fixed diagnostic, exit 1, no journal, no receipt — when neither is discoverable
  (spec WB-2, review P1-3). No doctor surface in this change.
- Receipt: `worker.codexHomeManaged: true` on executed workers; `not-started` shape unchanged.

- [ ] **Step 1: RED** — no auth file fixture and no `OPENAI_API_KEY`: run exits 1 with the fixed diagnostic,
  zero classifier attempts, empty journal, no receipt; with either source present the run proceeds.
- [ ] **Step 2: RED** — e2e receipt: executed worker carries `codexHomeManaged: true` within the exact expected
  key set; `not-started` receipt key set unchanged.
- [ ] **Step 3: RED** — payload framing regression (spec OC-2): final message `{"selected":"safe-a"}` against a
  schema demanding `{"selected","feasibleCount"}` (wrong shape, valid framing) classifies `strict`; existing
  8/8 payload tests stay green.
- [ ] **Step 4: GREEN** — implement; `pnpm test` green; commit
  `feat: refuse uncredentialed runs and attest the managed codex home`.

### Task 5: Documentation and the source→mechanism matrix

**Files:**
- Modify: `README.md` (worker/boundary paragraph, `--output-schema` usage, custom-round authoring rule)
- Modify: `.agents/skills/turnhelm-routing/SKILL.md` (harness paragraph rule, worker-boundary paragraph — same
  substance as README; `assets.ts` embeds this file, so its size cap of 64 KiB is checked)
- Test: `test/package.test.ts` only if it pins doc contents — extend the pin, else no test change.

**Interfaces:**
- DC-1 paragraphs: (a) native completion ≠ task verification — consumers gate on their own contracts;
  (b) enforced boundary (managed `CODEX_HOME`, ignored user config/rules, credential symlink, staged schema)
  with the documented residuals (HOME-rooted skill/hook/admin sources) stated as residuals — no universal
  isolation claim (spec DC-1, review P1-2).
- FX-1 rule in the custom-round authoring guidance: ordering/tie/direction-dependent oracles must state the
  direction and include one worked tied example; sealed oracles and grades are never edited (spec FX-1).

- [ ] **Step 1:** scan `codex exec --help` and the installed codex 0.162 docs offline for a no-inference
  introspection command (config/instruction dump). If one exists, add the behavioral check for the enforced set
  (spec §4 closing note); if not, record its absence here.
- [ ] **Step 2:** compile the source→mechanism matrix (each known codex 0.162 instruction/policy source →
  closed-by-empty-home / closed-by-flag / residual) from `--help` text and published docs only — no inference
  calls — and append it to the spec as §7.
- [ ] **Step 3:** write the two README paragraphs, the `--output-schema` usage line, and the SKILL.md rule
  paragraphs; run whatever doc-pin tests exist.
- [ ] **Step 4:** `pnpm test` green; commit `docs: worker instruction boundary, output schema, and fixture authoring rule`.

### Task 6: Final verification

- [ ] **Step 1:** `pnpm test && pnpm build` green; `git diff --check` clean; full suite count reported.
- [ ] **Step 2:** commit any residue with a conventional message; hand the branch to the user — no merge to
  main, no push without instruction.
