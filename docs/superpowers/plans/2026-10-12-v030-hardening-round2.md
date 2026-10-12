# v0.3.0 Validation Hardening Round 2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the custom-round validation tooling repo-owned code — a data-only-roster runner in `test/custom-round.ts` whose three spend gates (identity-before-spend, infrastructure-vs-assertion stop, no private grading primitives) are mechanically enforced — plus the two surviving deferred test minors.

**Architecture:** One new test-surface module (`test/custom-round.ts`, exported through `dist/test` like `live-acceptance`) with `prepare`/`execute` entry modes absorbing the sealed `freeze.mjs`/`business-run.mjs` flow; a runner-owned sandboxed check launcher with an explicit outcome protocol replaces exit-code/stderr inference; sandbox policy bytes are generated in memory per invocation (no persistent artifacts); round input is a validated JSON roster, never an imported module. Two small test hardenings in existing files. No `src/` change.

**Tech Stack:** TypeScript (strict, ESM), `node:test` via `pnpm test`, Node ≥ 24, macOS `sandbox-exec` for real SBPL paths. No new dependencies; no paid or live calls at any step; CI is Linux, so every gate test runs on hermetic launcher fakes and only real-SBPL execution is macOS-gated.

**Spec:** `docs/superpowers/specs/2026-10-12-v030-hardening-round2-design.md` (post-astra revision; §9 records all eleven dispositions — data-only roster, outcome protocol, identity-before-spend, approval boundary, dual env constructors, custom-runner scope, Linux-CI fakes, settlement-gap age pin, superseded trailer negative, seatbelt-as-decision).

## Global Constraints

- Diff surface exactly: new `test/custom-round.ts`, new `test/custom-round.test.ts`, `test/live-acceptance.test.ts` (TH-2 spawn pin only), `test/worker.test.ts` (TH-2 age pin only), `README.md`, `.agents/skills/turnhelm-routing/SKILL.md`, this plan, the spec. Nothing else; no `src/**` change, no `test/live-acceptance.ts` change, no dependencies, no schema/journal/stop-policy change to the standard harness.
- Round input is data-only JSON (spec §3.1): cases carry id, kind `worker-readonly|worker-write`, scope, task, transport `arg|stdin-file`, root, `allowedChanges`, `allowedProfiles`, grading mode `strict-equal|envelope-equal|strict-whole-json` (+ expected value). No import of round-supplied code; any task file or startup hook is hashed data.
- Zero spend means zero classifier requests and zero worker executions (spec §3.1); local sandboxed preflights are allowed subprocesses. Spend counters are asserted through the fake backends' self-recorded logs and the journal, never through reserved evidence records.
- Identity before every reservation/CLI launch: canonical `realpath` equality with the prepare-time record plus `dev`/`ino` (spec §3.2(1)); policy bytes from `oracleSandboxPolicy` in memory per invocation via a launcher-managed temp profile file deleted after use. No profile text in the manifest.
- Outcome protocol (spec §3.2(2)): the runner-owned in-sandbox wrapper emits one final marked line `__TURNHELM_CHECK_OUTCOME__{"pass":true|false}`; the runner reads only that exact marker line (runner-defined format, never untrusted error text). Missing/duplicated-ambiguous marker, spawn error, death signal, timeout → infrastructure → integrity stop. A `pass:false` outcome is an ordinary case failure that continues per stop policy.
- Two environment constructors stay separate (spec §3.5): CLI child = sealed-round scrub list; oracle/reference/sentinel = fresh allowlist (`PATH`, `HOME`/`ZDOTDIR`/`TMPDIR` = case root, `LANG`, `TZ`), never the runner's env.
- Approval boundary (spec §3.4): manifest hashes runner module, `dist/test/live-acceptance.js`, repo HEAD, every case contract/reference/task/hook file, runtime identity (node version, `execPath` realpath), evidence-root `realpath`; `wx`-exclusive ledger at that root only.
- Stop policy and exits (spec §3.3): boundary/drift/output-cap/cleanup/infra failure stops all spend; output-only semantic misses continue; auth/rate-limit/usage-limit stop; exits 0 all-pass, 4 complete-with-failures, 1 structural, 130 SIGINT, 143 SIGTERM.
- All docs/comments in English. Conventional Commits. No push, no branch creation beyond `feat/v030-hardening-round2`, no PR, no live/paid calls without explicit user instruction.
- Gates: `pnpm test` green; `pnpm run test:coverage` green (80/80/80 on `dist/src/**` — test-only additions must not move it); real-SBPL tests skip cleanly on non-macOS.

## Review Focus

1. **Same-path root replacement** (inode changes, bytes identical): identity check refuses before reservation with zero spend — byte comparison would pass. → Task 5 Step 1.
2. **Outcome-marker absence or noise**: a check that crashes before the wrapper's marker, or a contract that prints marker-shaped text, must land as infrastructure stop / last-marker-only read — never an accidental pass or silent continue. → Task 3 Steps 1 and 6 Step 1.
3. **Manifest relocation and replay**: executing a copied manifest from another directory, or a second concurrent execute, must refuse (evidence-root identity, `wx` ledger). → Task 5 Step 1.
4. **Oracle environment leakage**: runner-env `NODE_OPTIONS`/`NODE_PATH` or a synthetic secret must never reach a sandboxed check — allowlist by construction, pinned by test. → Task 4 Step 1.
5. **Grading-mode swap**: the case-16 footer shape passes `envelope-equal` (with matching payload) but fails `strict-whole-json`; modes must not silently substitute. → Task 5 Step 1.

---

### Task 1: Fake-worker spawn-count pin (TH-2 minor 1)

**Files:**
- Modify: `test/live-acceptance.test.ts` (TH-1 continuation pin + fake-worker fixture)

**Interfaces:** Consumes: existing `buildRun`/fake-worker env pattern and the round-1 TH-1 pin test. Produces: the fake worker appends one line per invocation to a file at an env-provided scratch path; tests read that log.

- [ ] **Step 1: Failing test** — extend the fake-worker fixture to self-record invocations; change the TH-1 continuation pin's spawn assertion from reserved-record count to the recorded invocation count (2). Also assert a zero-spawn roster scenario records 0.
- [ ] **Step 2: Verify** — `pnpm run build && node --test dist/test/live-acceptance.test.js` → FAIL (no invocation log yet).
- [ ] **Step 3: Implement** — fake worker appends `JSON.stringify({argv: process.argv.length})`-style line to `${scratch}/invocations.log` on start; tests read and count lines.
- [ ] **Step 4: Focused green** — same command → PASS.
- [ ] **Step 5: Commit** — `git add test/live-acceptance.test.ts && git commit -m "test(harness): pin actual fake-worker invocations, not reserved records"`

### Task 2: Settlement-gap age pin (TH-2 minor 3)

**Files:**
- Modify: `test/worker.test.ts` (existing `WorkerScenario` fixture pattern)

**Interfaces:** Consumes: round-1 `progressEvents`/`lastEventAgeMs` on `WorkerResult`. Produces: nothing.

- [ ] **Step 1: Failing test** — new scenario: write all frames, deliver them (await a macrotask tick so the decode loop drains — no backpressured frame remains), hold the stream open ≥ 5 ms with no further writes, then end. Assert `lastEventAgeMs > 0` and `progressEvents` equals the frame count. Existing scenarios keep presence/integer assertions only.
- [ ] **Step 2: Verify** — `pnpm run build && node --test dist/test/worker.test.js` → FAIL (current tests assert presence only; new scenario asserts `> 0`).
- [ ] **Step 3: Implement** — fixture-only change (hold-open delay after drain); no production change expected — if it fails against production, `lastEventAt` bookkeeping is wrong and must be fixed per spec §4(2).
- [ ] **Step 4: Focused green** — same command → PASS.
- [ ] **Step 5: Commit** — `git add test/worker.test.ts && git commit -m "test(codex): pin positive lastEventAgeMs via a post-drain settlement gap"`

### Task 3: Runner-owned sandboxed check launcher (RT-1 core)

**Files:**
- Create: `test/custom-round.ts`
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Consumes: `oracleSandboxPolicy` from `test/live-acceptance.ts` (as-is).
- Produces: `export type CheckOutcome = { status: "pass" } | { status: "failed" } | { status: "infrastructure"; reason: "spawn-error" | "signal" | "timeout" | "missing-outcome" }` and `export async function runSandboxedCheck(options: { sandboxExecPath: string; runtimeDir: string; cwd: string; entryScript: string; allowReadSubpaths: readonly string[]; timeoutMs: number }): Promise<CheckOutcome>` — generates the SBPL profile in memory, writes it to a launcher-managed temp file, runs the wrapper + entry under `sandbox-exec -f`, reads the final `__TURNHELM_CHECK_OUTCOME__` marker line, deletes the temp profile. Also `export const CHECK_WRAPPER_SOURCE: string` (the in-sandbox wrapper source the runner ships; baseline-hashed).

- [ ] **Step 1: Failing tests (hermetic, all platforms)** — with a fake `sandbox-exec` script (path-injected) that execs its args: (a) entry whose contract asserts false → wrapper marker `pass:false` → `{status:"failed"}`; (b) entry that crashes before any marker → `{status:"infrastructure", reason:"missing-outcome"}`; (c) fake sandbox-exec missing → `spawn-error`; (d) fake that ignores SIGTERM past timeout → `timeout`; (e) entry printing a forged marker line mid-run then failing → outcome is the **final** marker line only; (f) allowlist env: fake sandbox-exec dumps its env → assert `NODE_OPTIONS`, `NODE_PATH`, and a synthetic secret are absent, `HOME`/`ZDOTDIR`/`TMPDIR` equal the case root; (g) profile temp file deleted after the run.
- [ ] **Step 2: Verify** — `pnpm run build && node --test dist/test/custom-round.test.js` → FAIL (module absent).
- [ ] **Step 3: Implement** — wrapper (`CHECK_WRAPPER_SOURCE`): dynamic-imports the entry, catches, prints the one marked JSON line last; launcher: `execFile`-style spawn with the fresh allowlist env, bounded stdout capture, timeout + SIGTERM, marker-line scan (exact prefix match), temp-profile lifecycle.
- [ ] **Step 4: Focused green** — same command → PASS.
- [ ] **Step 5: macOS-gated real-SBPL test** — `skip(process.platform !== "darwin")`: real `runSandboxedCheck` over a reference entry that reads an allowed subpath (pass) and one reading the sentinel outside it (`missing-outcome`/crash shape → infrastructure, not a forged grade). Use the existing `oracleSandboxPolicy` test's root layout as fixture guide.
- [ ] **Step 6: Commit** — `git add test/custom-round.ts test/custom-round.test.ts && git commit -m "feat(harness): sandboxed check launcher with an explicit outcome protocol"`

### Task 4: Roster validation and manifest freeze (RT-1 prepare)

**Files:**
- Modify: `test/custom-round.ts`
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Consumes: Task 3's `runSandboxedCheck`; `validateTask` from `src/task.ts`.
- Produces: `export async function prepareRound(rosterPath: string): Promise<{ manifestPath: string; approvalSha256: string }>` — validates the data-only roster (exact key set, sizes, `validateTask` on every task, grading mode + expected value), hashes the consumed-file baseline (runner module, `dist/test/live-acceptance.js`, repo HEAD, per-case contract/reference/task/hook files), pins runtime identity (node version, `execPath` realpath) and evidence-root `realpath`, runs local preflights (reference GREEN, broken-fixture RED, sentinel isolation) over the final roster, and emits the manifest + approval request. Manifest carries **no profile text**.

- [ ] **Step 1: Failing tests** — (a) valid two-case roster → manifest with the exact hash-list keys and zero classifier/worker counters in the prepare summary; (b) unknown key, oversize task, invalid task text, missing root → refused, no manifest; (c) preflight with a broken reference (RED path) → refused; (d) preflight infra failure (fake sandbox-exec missing) → refused as infrastructure, not a roster validation error; (e) HEAD or `dist/test/live-acceptance.js` mutated between roster and prepare call → baseline refusal.
- [ ] **Step 2: Verify** — FAIL.
- [ ] **Step 3: Implement** — roster parse/assert; consumed-file enumeration from the roster; preflight wiring through `runSandboxedCheck`; manifest assembly (version, kind `custom-round`, head, baseline, runtime, evidenceRoot, cases, caps); approval request output.
- [ ] **Step 4: Focused green** — PASS.
- [ ] **Step 5: Commit** — `git add test/custom-round.ts test/custom-round.test.ts && git commit -m "feat(harness): data-only roster validation and manifest freeze for custom rounds"`

### Task 5: Gated execute loop (RT-1 execute)

**Files:**
- Modify: `test/custom-round.ts`
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Consumes: Task 3 launcher, Task 4 manifest; `superviseCli`, `envelopePayload` from `test/live-acceptance.ts`; the repo CLI at `dist/src/cli.js`.
- Produces: `export async function executeRound(manifestPath: string, approvedSha256: string): Promise<number>` (process exit code). Per case: identity re-check → scrubbed CLI env → `superviseCli` run → capture stdout/stderr/receipt/journal → grading (`envelope-equal` via `envelopePayload` + deep-equal; `strict-equal` deep-equal on parsed whole stdout; `strict-whole-json` strict parse) → sandboxed contract check for `worker-write` → evidence record append.

- [ ] **Step 1: Failing tests (hermetic fakes, all platforms)** — reuse the fake classifier/worker env pattern with the Task 1 self-recording log idiom: (a) happy path, two cases → exit 0, ledger `wx` at the manifest root, both cases graded; (b) **same-path root replacement between prepare and execute → refused before any launch, zero fake-worker invocations, zero journals**; (c) copied/relocated manifest → evidence-root identity refusal; (d) second concurrent execute → `wx` failure; (e) roster task-file mutated after prepare → hash refusal; (f) grading modes: footer stdout passes `envelope-equal` (payload matches) and fails `strict-whole-json`; `strict-equal` exact match passes; (g) CLI env: fake worker records its env → Jev/legacy keys, `BASH_ENV`/`ENV` absent.
- [ ] **Step 2: Verify** — FAIL.
- [ ] **Step 3: Implement** — manifest/sha verification; per-case identity gate (`realpath` + `dev`/`ino`); env constructors; supervision; grading switch; ledger records (bounded, whitelisted fields, `oracleInput` per harness rules); pre-reservation baseline re-verify.
- [ ] **Step 4: Focused green** — PASS.
- [ ] **Step 5: Commit** — `git add test/custom-round.ts test/custom-round.test.ts && git commit -m "feat(harness): gated custom-round execute with identity-before-spend"`

### Task 6: Stop policy, lifecycle, exits (RT-1 close-out)

**Files:**
- Modify: `test/custom-round.ts`
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5. Produces: the stop predicate (integrity key included), signal handling, exit-code mapping; nothing new exported.

- [ ] **Step 1: Failing tests** — (a) ordinary assertion failure (wrapper `pass:false`) on case 1 of 2 → roster continues, exit 4, both cases run; (b) injected infra failure on case 1 → integrity stop, **no second spawn** (invocation log), exit 1; (c) auth-class failure receipt → stop; (d) SIGINT → graceful close, exit 130; SIGTERM → 143; (e) caps: roster exceeding declared caps refused at execute.
- [ ] **Step 2: Verify** — FAIL.
- [ ] **Step 3: Implement** — stop predicate with integrity/auth classes; signal ladder (first SIGINT graceful, SIGTERM immediate-143); exit mapping 0/4/1/130/143.
- [ ] **Step 4: Focused green** — PASS; also run the macOS-gated real-SBPL tests from Task 3 Step 5 on this branch.
- [ ] **Step 5: Commit** — `git add test/custom-round.ts test/custom-round.test.ts && git commit -m "feat(harness): integrity stop policy and lifecycle for custom rounds"`

### Task 7: Documentation sync

**Files:**
- Modify: `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (kept in doc parity)

**Interfaces:** Consumes: spec §3 semantics. Produces: nothing.

- [ ] **Step 1: Edit both docs** — one paragraph each: the custom-round runner (data-only roster, prepare/execute with human hash-approval, zero-spend meaning, integrity-stop semantics, macOS-only real sandbox, `dist/test` import surface) and the TH-2 pins; no other claims change.
- [ ] **Step 2: Parity + gates** — diff the paragraphs against each other; `pnpm test` green; `pnpm run test:coverage` green (80/80/80); `git diff main --stat` confined to the Global Constraints file list.
- [ ] **Step 3: Commit** — `git add README.md .agents/skills/turnhelm-routing/SKILL.md && git commit -m "docs: custom-round runner and spend-gate semantics"`

## Final gate

- [ ] `pnpm test` green on the full branch; `pnpm run test:coverage` green; `git diff feat/v030-hardening --stat` confined to the Global Constraints file list (this branch's base); no live/paid calls made at any point; real-SBPL tests verified to skip on Linux (`[skip]` lines present, suite green).
