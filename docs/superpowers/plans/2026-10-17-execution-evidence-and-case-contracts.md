# Execution Evidence and Case Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the spec's case contracts (per-case output schemas), bounded content-free worker lifecycle evidence, oracle/fixture identity binding, per-case deadline ownership, and the three bounded fixes (AF-1..AF-3).

**Architecture:** Product gains one opt-in lifecycle recorder (ring + append-only journal) threaded through `executeWorker` into the receipt; both harnesses gain frozen per-case schema/deadline fields in their manifests; custom-round freezes dev/ino identity for every roster-referenced file and re-verifies around grading; two fixture-level test repairs. No routing, transport, or config changes.

**Tech Stack:** TypeScript (tsc, ESM), Node >= 24.5.0 stdlib only, `node:test`, pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-execution-evidence-and-case-contracts-design.md` (§ numbers below refer to it). The plan argues from the spec; executors read both.

## Global Constraints

- **Offline only, zero paid calls** (spec §4): every test uses fake codex binaries, injected request seams, or fixture classifiers. No classifier request, no worker, no `--probe` dial.
- **Work on a fresh feature branch** created only on explicit user go-ahead (spec status banner); base = `main` containing the spec commit. Never implement on `docs/open-findings-resolution-spec`.
- **Nothing weakens an existing gate to make a test pass** (spec §2). Existing root/tree/receipt/caps gates keep their semantics.
- **No backward compatibility** (spec header): roster/manifest/case shapes may add required fields and refuse old shapes. Manifests stay single-use; `prepare` spends nothing.
- **Content-free evidence** (spec §3.2): lifecycle records carry kinds, integer timestamps, PIDs, exit codes, and enum statuses only — never event text, task text, or error text.
- **Fixed wording** for every new user-facing string (diagnostics, refusals, doctor evidence); native error text never surfaces.
- Test command: `pnpm test` (= build + `node --test dist/test/*.test.js`). Targeted: `pnpm run build && node --test dist/test/<file>.test.js` (add `--test-name-pattern "<substring>"` for one test). The build step is required before every run.
- Docs/comments in English. `README.md` and the routing SKILL.md are the same inode — edit once via `README.md`.
- Conventional Commits; every commit message ends `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- Surgical changes: every changed line traces to the spec item its task names (§5 non-goals are binding — nothing from the avoid-lists ships).

## Review Focus

Input classes the spec implies but no task's tests fully exercise — each is pinned by the named test in its owning task:

1. A chatty worker decoding hundreds of events must not grow an unbounded lifecycle record; capacity exhausts with an overflow marker while terminal milestones survive — `test/lifecycle.test.ts` "ring keeps the head, the tail, and an overflow marker" (Task 4).
2. An oracle root swapped for a same-path, same-content replacement (new inode) between prepare and grading must stop the round, not grade — `test/custom-round.test.ts` "an oracle root rebind with identical contents stops as oracle-identity" (Task 5).
3. A roster naming an output-schema file the CLI itself would reject must fail at prepare, before any spend — `test/custom-round.test.ts` "prepare refuses a roster schema the CLI would reject, before spend" (Task 2).
4. A per-case timeout whose cleanup is uncertain must still stop all further spend even though timeouts are now continuable — existing `test/live-acceptance.test.ts` "a lingering descendant stops the round as cleanup-unverified" stays green (Task 7).
5. An outer SIGKILL of the CLI before settlement must leave the lifecycle journal readable — persisted-as-occurred is the whole point — `test/worker.test.ts` "the lifecycle journal outlives an outer kill before settlement" (Task 4).

---

### Task 1: AF-1 — doctor surfaces the retained HTTP status (spec §3.5)

**Files:**
- Modify: `src/doctor.ts` (`runProbe` :54-97, `PROBE_STATUS` :93-97, `backendCheck` :274-308)
- Test: `test/doctor.test.ts`

**Interfaces:**
- Consumes: `classifierFailure(error).httpStatus` from `src/systemone.ts:49` (already exported).
- Produces: `runProbe(backend, config, env, request, callerSignal): Promise<Readonly<{ outcome: ProbeOutcome; httpStatus: number | null }>>`. `DoctorCheck` shape unchanged — the status rides `evidence` text only.

- [ ] **Step 1: Write the failing test**

In `test/doctor.test.ts`, following the existing injected-request probe pattern: a config with the backend enabled and eligible, `options.request` rejecting with `new ClassifierRequestError({ kind: "http", httpStatus: 451, code: null }, "refused")`, `probe: true`. Assert the `backend.<id>` check: `status === "fail"`, `evidence` contains `"HTTP status 451"`, `next` contains `"resolve access with its operator"`. Add a second case: a request that never settles under a tiny `routingTimeoutMs` (budget-abort path) asserts `status === "fail"` and `evidence` does NOT contain `"HTTP status"` (no fabricated status).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run build && node --test dist/test/doctor.test.js`
Expected: FAIL — evidence lacks the status; type mismatch on `runProbe` return.

- [ ] **Step 3: Implement**

`runProbe`: keep the rejection via `classifierFailure(error).httpStatus` in the `attempted` promise's rejection handler (return `{ outcome: "failed", httpStatus: classifierFailure(error).httpStatus }`); the `bounded` race resolves `{ outcome, httpStatus: null }`; early returns become `{ outcome: "cancelled", httpStatus: null }` / `{ outcome: "failed", httpStatus: null }`. `backendCheck` builds the failed evidence as the existing fixed sentence plus `"; last observed HTTP status " + httpStatus` only when `httpStatus !== null`, and the failed `next` becomes fixed copy: `"disable the backend in .turnhelm/config.json or resolve access with its operator, then re-run turnhelm doctor --probe"`. No causation wording, no transport change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/doctor.test.js`
Expected: PASS (whole file — the cancelled and pass paths keep their existing evidence).

- [ ] **Step 5: Commit**

```bash
git add src/doctor.ts test/doctor.test.ts
git commit -m "feat: doctor probe surfaces the retained http status with fixed guidance"
```

### Task 2: SC-1 — per-case output schema in custom-round + shared validator (spec §3.1)

**Files:**
- Create: `src/output-schema.ts`
- Modify: `src/cli.ts:138-191` (import instead of local), `test/custom-round.ts` (roster types :234-246, validation in `prepareRound` :524, `RoundCase`/manifest :623-645, worker CLI invocation ~:1072)
- Test: `test/custom-round.test.ts`, `test/cli.test.ts` (must stay green)

**Interfaces:**
- Produces: `export const SCHEMA_MAX_BYTES = 64 * 1024;` and `export function validateOutputSchema(path: string): { bytes: Buffer } | { error: string }` — moved verbatim from `src/cli.ts:138-191`.
- Produces: `RosterCase` gains optional `outputSchema?: string` (path to a JSON Schema data file, roster-referenced like `files.contract`); the frozen `RoundCase`/manifest entry gains `outputSchema?: Readonly<{ path: string; sha256: string }>`.

- [ ] **Step 1: Extract the validator (pure refactor)**

Move `SCHEMA_MAX_BYTES` + `validateOutputSchema` verbatim into `src/output-schema.ts` with the same comment block; `src/cli.ts` imports them. Run `pnpm test` — the existing cli schema tests must stay green unchanged (they cover the moved behavior; no new test needed for a verbatim move).

- [ ] **Step 2: Write the failing tests**

Three tests in `test/custom-round.test.ts`, using the existing hermetic prepare/execute fixtures:
(a) "prepare refuses a roster schema the CLI would reject, before spend" — a roster case whose `outputSchema` points at an invalid file (non-UTF-8 bytes or a JSON array): `prepareRound` refuses with fixed wording and writes no manifest.
(b) "prepare freezes a valid roster schema into the manifest" — valid object schema: the manifest's case entry records `outputSchema.path` + `sha256` matching the file.
(c) "the worker CLI receives --output-schema only for schema cases" — invocation-capture run (the existing pattern that observes actual fake-worker argv): the case's CLI argv contains `--output-schema <frozen path>`; a schema-less case's argv does not.

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: FAIL — unknown roster field refused / no freeze / no flag.

- [ ] **Step 4: Implement**

Roster validation: accept `outputSchema` as a data-file reference; at prepare, read it through `validateOutputSchema` and refuse on `{ error }` with that fixed wording (spend nothing, write nothing); freeze `{ path, sha256 }` into the case manifest entry alongside the other file references. At execute, the per-case frozen-file re-verification already re-hashes roster files — include this one; append `["--output-schema", frozenPath]` to the worker CLI invocation only when present. Grading, `payload.mode` classification, and the exact oracle are untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/custom-round.test.js dist/test/cli.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/output-schema.ts src/cli.ts test/custom-round.ts test/custom-round.test.ts
git commit -m "feat: custom-round cases freeze and pass per-case output schemas"
```

### Task 3: SC-1 — per-case output schema in standard acceptance (spec §3.1)

**Files:**
- Modify: `test/live-acceptance.ts` (`AcceptanceCase` :34-47, case building in `prepareAcceptance` :650, worker CLI invocation ~:1738)
- Test: `test/live-acceptance.test.ts`

**Interfaces:**
- Consumes: `validateOutputSchema` from `src/output-schema.ts` (Task 2).
- Produces: `AcceptanceCase` gains `outputSchema?: Readonly<{ relative: string; sha256: string }>`; the frozen schema for `stdout-json` cases is the exact bytes of `{"type":"object","required":["count","sum"],"properties":{"count":{"type":"number"},"sum":{"type":"number"}},"additionalProperties":false}`.

- [ ] **Step 1: Write the failing tests**

(a) "prepare writes and freezes the stdout-json case schema": after `--prepare`, the case root contains the schema file at the recorded relative path with the recorded sha256, and the manifest case entry carries `outputSchema`.
(b) "the acceptance worker CLI passes --output-schema for stdout-json cases and not for summary-file cases": invocation-capture assertions over the actual CLI argv, in the existing fake-codex observation style.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: FAIL — no field, no file, no flag.

- [ ] **Step 3: Implement**

At prepare, for every `worker-readonly` + `stdout-json` case: validate the fixed schema bytes through `validateOutputSchema` (write to a temp file first or refactor it to accept bytes — prefer adding `validateOutputSchemaBytes(bytes)` in `src/output-schema.ts` with the path variant delegating to it), write the file into the case root, record `{ relative, sha256 }` on the case, and include it in `inputHashes`. At execute, append `--output-schema <caseRoot>/<relative>` to the CLI argv for cases that carry it. The oracle still deep-compares; no grading change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/output-schema.ts test/live-acceptance.ts test/live-acceptance.test.ts
git commit -m "feat: acceptance stdout-json cases pass frozen output schemas"
```

### Task 4: EV-1 — product lifecycle recorder, journal, flag, receipt (spec §3.2)

**Files:**
- Create: `src/lifecycle.ts`
- Modify: `src/codex.ts` (`executeWorker` :173+, milestone hooks at the existing named closures: `beginShutdown` :406, `dischargeShutdown` :384, `recordFailure` :444, `finish` :295, frame loop :665-690), `src/journal.ts` (extract shared safe-append), `src/cli.ts` (parse `--lifecycle`, wire, receipt projection ~:317)
- Test: create `test/lifecycle.test.ts`; modify `test/worker.test.ts` (new fake-codex modes)

**Interfaces:**
- Produces (`src/lifecycle.ts`):
  ```ts
  export type LifecycleKind = "spawned" | "stdin-delivered" | "event" | "completion" | "failure"
    | "abort" | "shutdown-term" | "shutdown-kill" | "shutdown-discharged" | "stdout-end" | "close" | "settle";
  export type LifecycleEvent = Readonly<{ tMs: number; kind: LifecycleKind;
    detail?: Readonly<{ eventKind?: string; pid?: number; exitCode?: number | null; signal?: string; status?: string }> }>;
  export const LIFECYCLE_CAPACITY = 64;
  export class LifecycleRecorder {
    constructor(append: (event: LifecycleEvent) => void);
    record(kind: LifecycleKind, detail?: LifecycleEvent["detail"]): void;
    snapshot(): Readonly<{ events: readonly LifecycleEvent[]; overflow: boolean }>;
  }
  ```
  Ring semantics: keep the first 8 and the last 56 entries (64 total); when more than 64 were recorded, `overflow: true` and the array still holds exactly 64 (head 8 + tail 56). The `settle` event is recorded last and is therefore always in the tail.
- Produces: `WorkerResult` gains `lifecycle?: Readonly<{ events: readonly LifecycleEvent[]; overflow: boolean }>`; `executeWorker` options gain `lifecycle?: LifecycleRecorder`.
- Produces (`src/journal.ts`): `export function appendLifecycleEvent(root: string, event: { pid: number } & LifecycleEvent, diagnostic?): Promise<void>` appending one JSON line `{type:"turnhelm.worker-lifecycle", pid, tMs, kind, detail?}` to `<root>/.turnhelm/lifecycle.jsonl` with the same safe-open discipline (O_NOFOLLOW|O_NONBLOCK, regular-file check, best-effort — never fails the run) as `appendRouteJournal`; extract the shared open/append core into one private helper used by both.

- [ ] **Step 1: Write the failing unit tests** (`test/lifecycle.test.ts`)

"ring keeps the head, the tail, and an overflow marker": record `spawned`, then 200 `event` entries, then `settle`; assert `snapshot().overflow === true`, `events.length === 64`, `events[0].kind === "spawned"`, `events.at(-1).kind === "settle"`, `tMs` values are non-decreasing. Also: the append sink received every event as it occurred (persisted-as-occurred at the unit level).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run build && node --test dist/test/lifecycle.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lifecycle.ts` and the journal helper; run unit tests green**

- [ ] **Step 4: Write the failing integration tests** (`test/worker.test.ts`)

Add fake-codex modes to the existing fixture: `"stall"` (emits one `item.completed` agent_message, then holds with an interval — no terminal event, never exits) and `"event-flood"` (emits 100 `item.completed` tool-progress frames, one message, then `turn.completed`).
(a) "a completed run's receipt carries a bounded content-free lifecycle": run the CLI with `--lifecycle`; assert `recorded.lifecycle.events` non-empty, first kind `spawned`, last kind `settle`, and `JSON.stringify(recorded.lifecycle)` does not contain the fake answer text (content-free).
(b) "the lifecycle journal outlives an outer kill before settlement": CLI with `--lifecycle` and mode `stall`; poll `.turnhelm/lifecycle.jsonl` until a line with `kind:"event"` for this CLI pid appears (bounded watchdog), SIGKILL the CLI, then assert the journal file holds `spawned` and `event` lines for that pid and no `settle` line.
(c) "an event flood trips the overflow marker without losing the settlement tail": mode `event-flood`; assert `recorded.lifecycle.overflow === true` and last kind `settle`.

- [ ] **Step 5: Run to verify they fail, then implement**

Milestones in `executeWorker` (all one-line `options.lifecycle?.record(...)` calls at existing sites; thread correlation is deliberately absent — the event stream provides none, so the field degrades): `spawned{pid}` after spawn, `stdin-delivered` where `inputDelivered` flips, `event{eventKind}` per decoded frame in `processFrames`, `completion` where `completionSeen` flips, `failure` in `recordFailure`, `abort` in `onAbort`, `shutdown-term`/`shutdown-kill` in `beginShutdown`'s ladder, `shutdown-discharged` in `dischargeShutdown`, `stdout-end` at the stdout end, `close{exitCode,signal}` in the close handler, `settle{status}` in `finish` before `resolve`. `finish` attaches `snapshot()` to the result.
`src/cli.ts`: parse `--lifecycle` (USAGE updated); in `runCommand`, when set, construct the recorder with an append sink writing through `appendLifecycleEvent(root, {pid: process.pid, ...event}, diagnostic)`; pass it to `executeWorker`; project `result.lifecycle` into the receipt's worker object. Without the flag, nothing records and no journal line is written (opt-in).

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/lifecycle.test.js dist/test/worker.test.js dist/test/route-journal.test.js`
Expected: PASS (route-journal confirms the refactor of the shared append core).

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle.ts src/codex.ts src/journal.ts src/cli.ts test/lifecycle.test.ts test/worker.test.ts
git commit -m "feat: opt-in bounded content-free worker lifecycle evidence"
```

### Task 5: OR-1 — oracle/fixture identity binding in custom-round (spec §3.3, P1)

**Files:**
- Modify: `test/custom-round.ts` (file-freeze sites :560/:1038, contract load ~:1161, stop set in `runGatedRound` :966+)
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Produces: every roster-referenced data file (`files.contract`, `files.taskFile`, `files.hooks[]`, `outputSchema`) freezes as `{ path, sha256, dev, ino }` in the manifest; new stop reason `"oracle-identity"` (exit 1, same family as `root-identity`/`tree-drift`).

- [ ] **Step 1: Write the failing test**

"an oracle root rebind with identical contents stops as oracle-identity": single-case roster referencing a contract file; after `prepareRound`, rename the contract's parent directory away and recreate the directory + a byte-identical contract file at the same path (new inode). `executeRound` must stop with `stopped {reason:"oracle-identity"}`, exit 1, and write no worker reservation for the case (identity-before-spend).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: FAIL — the run proceeds (hash matches) or stops with a different reason.

- [ ] **Step 3: Implement**

At prepare, `statSync` each referenced file and freeze `dev`/`ino` beside the existing sha256. At execute: re-verify `dev`/`ino` + hash with the other pre-spend frozen-file checks (this is the stop the test drives); then wrap the contract-check invocation — re-verify identity immediately before the sandboxed check runs and again before its outcome record is accepted; any mismatch stops `oracle-identity` with zero further spend. A matching pathname or hash alone never passes once identity is frozen. Do not touch the consumer-root dev/ino gates or the settled-tree gate.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: PASS — including every existing legitimate-oracle test unchanged.

- [ ] **Step 5: Commit**

```bash
git add test/custom-round.ts test/custom-round.test.ts
git commit -m "feat: custom-round freezes and re-verifies oracle file identity"
```

### Task 6: DL-1 — per-case deadline ownership in custom-round (spec §3.4)

**Files:**
- Modify: `test/custom-round.ts` (`RosterCase` :241, `RoundCase` :623, `CASE_TIMEOUT_MS` :648, deadline use ~:1092/:1214)
- Test: `test/custom-round.test.ts`

**Interfaces:**
- Produces: `RosterCase` gains required `deadlineMs: number` (integer, `5_000 <= deadlineMs <= 3_600_000`); the manifest case entry freezes it; `export const DEFAULT_CASE_DEADLINE_MS = 240_000` replaces `CASE_TIMEOUT_MS` (constant rename — no alias; update all references); `executeRound`'s `options.caseTimeoutMs` is removed (tests set per-case `deadlineMs` instead). Clock scope: monotonic `performance.now` from CLI spawn to supervision settlement; the existing cleanup grace stays a separate budget that execution can never extend.

- [ ] **Step 1: Write the failing tests**

(a) "prepare refuses a roster case without deadlineMs" and (b) "...with an out-of-bounds deadlineMs" — fixed refusal wording, no manifest.
(c) Repurpose the existing timeout-continuation regression (currently at `test/custom-round.test.ts:1568/:1680` area): a case with a small `deadlineMs` and a stalled fake worker times out unjudged, and the next case still executes.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: FAIL — missing-field cases currently pass prepare; fixtures lack the field.

- [ ] **Step 3: Implement**

Roster validation requires and bounds `deadlineMs`; freeze it in the case manifest; the runner supervises each case under its own frozen deadline. Update every existing roster fixture in the tests to carry an explicit `deadlineMs` (use the old effective value unless the test shortens it). A timeout stays an unjudged per-case outcome behind the existing receipt/cleanup/settled-tree gates — no duration anywhere changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/custom-round.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/custom-round.ts test/custom-round.test.ts
git commit -m "feat: custom-round cases own frozen per-case deadlines"
```

### Task 7: DL-1 — continuable, gated timeouts in standard acceptance (spec §3.4)

**Files:**
- Modify: `test/live-acceptance.ts` (timeout stop ~:1825-1831, case records, `completed` record, exit semantics)
- Test: `test/live-acceptance.test.ts`

**Interfaces:**
- Produces: `AcceptanceCase` gains required `deadlineMs: number` (same bounds as Task 6; prepare refuses absence/out-of-bounds); the observed-case record gains an unjudged `timeout` outcome; the `completed` record gains `timedOut: number`; worker-suite exit 4 covers `failed > 0 || timedOut > 0`.

- [ ] **Step 1: Write the failing tests**

(a) "a per-case timeout is unjudged and the roster continues": two cases; case 1 has a small `deadlineMs` with a stalled fake worker (Task 4's `stall` mode) — its record is `timeout` with no verdict; case 2 reserves and runs; final exit 4.
(b) The existing "a lingering descendant stops the round as cleanup-unverified" test must stay green unchanged (uncertain cleanup still stops — Review Focus 4).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: FAIL — timeout currently stops the round; no `deadlineMs` field.

- [ ] **Step 3: Implement**

Freeze `deadlineMs` per case at prepare (fixtures updated with the previous effective value unless shortening); supervise each case under its own deadline. On expiry: run the same cleanup verification the signal path uses — a verified-dead CLI plus a passing settled-tree check yields an unjudged `timeout` case record and the roster continues; an unverified close keeps stopping `cleanup-unverified`; all other stop reasons are untouched. Update the `completed`/exit reconciliation exactly as custom-round already does it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/live-acceptance.ts test/live-acceptance.test.ts
git commit -m "feat: acceptance timeouts become gated continuable per-case outcomes"
```

### Task 8: EV-1 — harness retention of worker timelines (spec §3.2)

**Files:**
- Modify: `test/live-acceptance.ts` (evidence projection beside `projectWorkerFailure` :997-1014, CLI invocation adds `--lifecycle`, killed-CLI journal read)
- Test: `test/live-acceptance.test.ts`

**Interfaces:**
- Consumes: receipt `worker.lifecycle` and `.turnhelm/lifecycle.jsonl` (Task 4); per-case timeout machinery (Task 7).
- Produces: `SafeEvidence` observed record gains `workerLifecycle?: Readonly<{ events: readonly { tMs: number; kind: string }[]; overflow: boolean }>` — whitelist-validated with the same strictness as `projectWorkerFailure` (unknown key inside a present projection rejects; a malformed entry drops the whole projection; events capped at 64).

- [ ] **Step 1: Write the failing tests**

(a) "a failed worker case retains its lifecycle projection": a case whose fake worker emits `turn.failed` — the observed record carries `workerLifecycle.events` ending in `failure` then `settle`.
(b) "a killed timed-out CLI retains its journal timeline without a receipt": the Task 7 timeout test's shape, asserting the case record carries `workerLifecycle` reconstructed from `.turnhelm/lifecycle.jsonl` filtered by the supervised CLI pid (completed runs may omit the projection — failed and timed-out workers are the retention contract).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: FAIL — no projection, no journal read.

- [ ] **Step 3: Implement**

Invoke the CLI with `--lifecycle` for worker cases; project `worker.lifecycle` from the receipt into `workerLifecycle` when the worker failed or the case timed out; when the CLI died without a receipt (timeout kill), reconstruct the bounded timeline from the journal by pid. Cross-run comparison needs no tooling — the retained records are the comparison surface.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/live-acceptance.ts test/live-acceptance.test.ts
git commit -m "feat: acceptance retains bounded worker timelines for failed and timed-out runs"
```

### Task 9: AF-2 — sentinel process-chain test (spec §3.6)

**Files:**
- Test: `test/worker.test.ts`

**Interfaces:**
- Consumes: the existing `runWorker(t, { parentEnv, script })` harness and fake-file evidence pattern (`test/worker.test.ts:546-566`).

- [ ] **Step 1: Write the failing test**

"a surviving descendant keeps the stripped key set and managed marker after leader exit" (timeout 30 s, mirroring sibling tests): `parentEnv` = an owned mkdtemp `HOME` containing a synthetic `.zshenv` (owned startup files; nothing host is read). The worker script writes its identity file `{pid, codexHome: process.env.CODEX_HOME}` and spawns ONE detached node descendant (inheriting stdio) that: (1) acknowledges readiness by writing `{pid}` to a pid file; (2) samples `Object.hasOwn` booleans for `LAYA_API_KEY`, `TYPESAFE_API_KEY`, `TURNHELM_ALLOW_HOSTED_JEV`, `TURNHELM_CONFIG`, `BASH_ENV`, `ENV`, plus `TURNHELM_MANAGED_CHILD` and `CODEX_HOME` and `ZDOTDIR`; (3) polls `process.kill(leaderPid, 0)` until ESRCH, then samples the same set again and writes both samples; then holds with an interval. The worker completes normally. Assertions: both samples show every stripped key absent, `TURNHELM_MANAGED_CHILD === "1"`, descendant `CODEX_HOME` equals the leader's recorded value (marker equality), `ZDOTDIR` equals `<consumerRoot>/.turnhelm`, the after-leader-exit sample exists, and the descendant pid differs from the leader pid. `t.after` reaps the recorded descendant pid (`SIGKILL`).

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm run build && node --test dist/test/worker.test.js`
Expected: FAIL — test absent (this is a new evidence pin; the failure is the missing test itself, then any real leak it catches).

- [ ] **Step 3: Implement the fixture script only (product code unchanged)**

If the assertions fail against current product behavior, that is a finding — stop and report per executing-plans, do not weaken the assertions. The claim supported stays mechanism-level; no real-codex descendant behavior is claimed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/worker.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/worker.test.ts
git commit -m "test: sentinel process chain pins descendant key set and marker across leader exit"
```

### Task 10: AF-3 — readiness-synchronized lingering-descendant fixture (spec §3.6)

**Files:**
- Modify: `test/live-acceptance.test.ts` (fake-codex `spawn-linger` mode :833-841; tests :2263-2282 and :2284-2302)
- Test: same file

**Interfaces:**
- Consumes: the existing `linger-forever` pid-file convention (`TURNHELM_LINGER_PID_FILE`, :871-884).

- [ ] **Step 1: Write the failing synchronization first**

Change the `spawn-linger` mode: the descendant writes its pid to `process.env.TURNHELM_LINGER_PID_FILE || join(process.cwd(), "linger.pid")` immediately, and no longer self-exits (delete the 4 s `setTimeout`). Update the two consuming tests: instead of the fixed `setTimeout(700)`, await the pid file under a bounded watchdog (5 s) before `controller.abort()` / `entry.kill("SIGINT")`, and reap the recorded pid in `t.after`/cleanup. Grep for every other `spawn-linger` user and update it the same way.

- [ ] **Step 2: Run the updated tests to verify they pass**

Run: `pnpm run build && node --test dist/test/live-acceptance.test.js`
Expected: PASS — including "a lingering descendant stops the round as cleanup-unverified" with the same assertions (stop reason ordering untouched).

- [ ] **Step 3: Bounded repeated run under the historical flake shape**

Run: `for i in 1 2 3 4 5; do node --test --test-name-pattern "lingering descendant" dist/test/live-acceptance.test.js || break; done`
Expected: 5/5 PASS. Any iteration failing is a finding, not a retry target.

- [ ] **Step 4: Commit**

```bash
git add test/live-acceptance.test.ts
git commit -m "test: lingering-descendant fixture acknowledges readiness before abort"
```

### Task 11: Docs + full-suite + coverage verification (spec §2, §3.7)

**Files:**
- Modify: `README.md` (same inode as the routing SKILL.md — edit once)

**Interfaces:**
- Consumes: every Produces block above.

- [ ] **Step 1: Update the docs**

Document, in the existing sections' style and length discipline: `run --lifecycle` (opt-in) + the receipt `lifecycle` projection + `.turnhelm/lifecycle.jsonl` (content-free, best-effort); doctor's failed-probe line carrying the observed HTTP status with fixed guidance; custom-round roster `outputSchema` and required `deadlineMs` + the `oracle-identity` stop; acceptance per-case schemas, per-case deadlines, continuable gated timeouts, and failed/timed-out timeline retention; one line stating the coverage-claim rule (admission rebinds mappings, so natural-coverage claims require unchanged-mapping runs — spec §3.7). No claim wording beyond what the tests pin.

- [ ] **Step 2: Full suite + coverage**

Run: `pnpm run test:coverage`
Expected: all tests PASS and the 80/80/80 coverage gates hold. Any pre-existing failure goes in the report by name.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: lifecycle evidence, case contracts, and deadline ownership"
```
