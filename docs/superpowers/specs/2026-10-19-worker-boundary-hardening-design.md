# Worker Boundary Hardening Design

Date: 2026-10-19. Code baseline: `2f66825e46faef88912e1c445b437af545e5a43c` (main).

> Status: the user requested a fresh branch, a spec driven only by long-term benefit, security, and
> performance (no backward-compatibility constraints), an independent Astra review with gap-finding
> and over-engineering control, a revised spec, and an execution plan. Current authority covers that
> review plus English documentation and local commits on this branch — not implementation, live
> provider calls, publication, or service/authentication/proxy changes. All prior campaign
> authorities remain closed.

## 1. Problem and evidence boundary

The sealed 104-case campaign at `2f66825` settled **COMPLETE-WITH-FAILURES** (100 pass, 2 failed,
2 unjudged timeouts, 3 calibration policy mismatches). Input report (private local evidence):
`/Users/zhangxiao/.local/state/turnhelm/validation-20261018-2f66825-0QRk4g/final-report/REPORT.md`.
Three recurring observation classes survive its evidence fences and are addressable in code:

| Observation | Established fact | Not established |
| --- | --- | --- |
| `feature-write-stdin`, `28-concurrency` timeouts | Frozen 240000 ms deadline expired with 3/7 decoded frames and `lastEventAgeMs` 197210/199155 — the worker went silent for ~82% of the budget while the parent waited the full deadline | Provider stall vs local hang vs approval wait; any internal cause |
| `30-incident` failure (and the 2026-10-17 `feature-prose` case) | A completed fast worker returned a schema-shaped **wrong refusal** claiming the read-only workspace "provides no file-reading tool" — twice observed across campaigns; readonly denies writes, never reads | An actual filesystem denial; whether a clarification changes the model's claim |
| `37-capacity` failure | A completed fast worker returned default-filled `0/0/false` without evident input reads; repeated from the prior sealed campaign; its fixed-balanced control passes | Whether input was read; a causal model/effort effect |

Alongside these, the documented worker instruction boundary leaves open residuals the report repeats
verbatim: "other shells' startup files" and "`$HOME/.agents/skills` discovery" remain reachable
because the child keeps the host `HOME` (only `ZDOTDIR` is redirected, which covers zsh alone).

Reading of the current code (all at the baseline): the task is delivered verbatim on stdin
(`src/codex.ts:44-55,178+`), the worker environment redirects `CODEX_HOME` and `ZDOTDIR` but not
`HOME` (`src/codex.ts:77-90`), the CLI has no internal deadline — only caller signals abort
(`src/cli.ts:148-156`), and `lastEventAt`/`progressEvents` already exist as parent observations
inside `executeWorker`. This design hardens exactly those three surfaces and nothing else.

## 2. Decision and scope

**Close the documented `HOME` residual, state sandbox semantics once in the worker instruction, and
make long silences abortable early — all as small, bounded, evidence-honest changes.** No new
subsystem, config version, retry path, or default behavior change enters through this design.

| Alternative | Decision |
| --- | --- |
| Redirect worker `HOME` to the managed per-run home | Adopt: one env assignment closes other shells' startup files and `$HOME/.agents/skills` discovery with the run's existing teardown |
| Add a sandbox-semantics note to the worker instruction | Adopt: a fixed, versioned, English constant appended after task validation — the only observed wrong-refusal class is a sandbox-policy misunderstanding |
| Internal stall watchdog, opt-in | Adopt: adaptive where a fixed deadline cannot be — fires only on measured silence after a decoded frame; default stays off |
| Raise fast tasks to balanced, refit band hypotheses, retry failures | Reject: calibration policy and outcome changes without diagnosed causes (report fences them) |
| Proxy-exit attestation, `AGENTS.override.md` closure, admin-hook isolation | Reject: not closable from this repository or requires unverifiable external proof |
| Prompt/content caching, dashboards, raw-event retention | Reject: no evidence need; privacy cost |

Unchanged: routing and classifier contracts, config v2 shape, task 8192-byte validation boundary,
managed `CODEX_HOME`/auth symlink lifecycle, sandbox selection per `--write`, output-schema staging,
payload framing, failure taxonomy and stop order, exactly-one-receipt behavior, terminal-event
settlement, all consumer gates, exit codes, and sealed artifacts. No new automatic request,
escalation, or retry is added anywhere.

## 3. Normative contract

### 3.1 Hermetic worker `HOME`

`workerEnvironment` additionally sets `HOME` to the same managed per-run home as `CODEX_HOME`, and
points `ZDOTDIR` at that managed home instead of the project `.turnhelm` root (a host-exported
`ZDOTDIR` must still not win; the managed home is removed with the run exactly as today, so the
redirect dies with it). The parent CLI process environment is untouched.

This intentionally removes host dotfiles from the worker's view: `~/.gitconfig`, `~/.npmrc` and
similar are no longer readable or inheritable by the worker or its descendants. That is the security
property, and it is also the behavior change: a write-mode task whose worker must create commits now
needs the identity stated in the task itself, and registry-authenticated installs inside a worker
require that authentication to arrive through the task's own inputs. These consequences are
documented, not mitigated with staged dotfiles — staging host secrets back in would undo the
closure. `TMPDIR`, the cwd project tree, and the argv/instruction surface are unchanged.

Not closed by this (and still documented as residuals): managed/admin hook layers outside
`CODEX_HOME`, a project `AGENTS.override.md`, and absolute reads of host files by an authorized
worker — hermetic `HOME` removes the *default discovery paths*, not the host filesystem boundary
itself.

### 3.2 Sandbox-semantics instruction note

After `validateTask` accepts the consumer's task, and only on the path that writes the worker's
stdin, the CLI appends one fixed English constant, so the worker instruction becomes
`task + "\n\n" + NOTE`. The classifier still receives the task alone; `routes.jsonl` task hashes and
lengths still describe the consumer's task. The note is a named constant with a version tag
(`sandbox-semantics-v1`) so evidence can identify the exact instruction generation without retaining
prose in receipts. Draft content, final wording fixed at implementation review:

> Sandbox semantics (fixed runner note, not from the requester): a read-only sandbox denies writes,
> never reads — every file in the working tree remains readable with your existing tools. A
> workspace-write sandbox additionally permits writes inside the workspace. Read any files the task
> references before answering, and report a read as denied only if an actual read attempt failed.

The consumer task-size limit still gates only the consumer's bytes; validation order and rejection
semantics are untouched. The executed-worker receipt carries the version tag
(`instructionNote: "sandbox-semantics-v1"`) as a mechanism attestation — the same honesty class as
`codexHomeManaged`, not a claim the worker obeyed the note. If the tag is absent, no note was
appended. This is a prompt-boundary mitigation for an observed twice-seen failure class, not a
guarantee: schema gates and consumer oracles remain the acceptance authorities.

### 3.3 Opt-in stall abort

`turnhelm run` gains `--stall-abort-ms <integer>` (default absent = disabled; accepted range
5000–3600000, mirroring roster deadline bounds; rejected like any malformed flag). The custom-round
roster case gains an optional `stallAbortMs` with the same validation, frozen into the manifest at
prepare; the runner passes it through as the CLI flag. Nothing else in the roster/manifest schemas
changes, and standard acceptance adopts the same per-case passthrough.

Inside `executeWorker`, the watchdog arms only after the first successfully decoded frame and fires
only when all hold: no terminal event yet, no shutdown started, not finished, and
`now - lastEventAt >= stallMs`. A run with zero decoded frames never stall-aborts — absent evidence
is unknown, and a silent-from-birth worker stays under the consumer's ordinary deadline. On firing,
the watchdog records one lifecycle event (`stall-abort`) and drives the existing owned shutdown
ladder unchanged (SIGINT, grace, SIGTERM, discharge); settlement, receipt emission, and home
teardown are exactly the existing abort path. The worker receipt gains
`abortReason: "stall"` — present only on this path, absent on caller aborts — alongside the existing
`ownedShutdown: true`, `progressEvents`, and `lastEventAgeMs`, which already describe the silence.
No new failure class, status value, or exit code is invented: the CLI process exits as a cancelled
run does (exit 1 absent a signal), and stall abort remains a parent-observed action record, never a
liveness or causation claim.

Both harnesses map a lone attributable receipt carrying `worker.abortReason: "stall"` to their
existing **unjudged timeout** outcome — the same semantics as an expired deadline, decided at the
same position in the existing decision order, before grading. Without this mapping an early-settled
stall would misgrade as a task failure; with it, a roster saves the silent remainder of its budget
without changing what the case proves. Timeout stays unjudged: no oracle, no contract check, case
continues.

### 3.4 Evidence projections

The shared worker-receipt projections in both harnesses (`workerFailure` and the receipt `worker`
object whitelists) admit exactly two new bounded fields — `instructionNote` (fixed version tag) and
`abortReason` (enum, `"stall"` only) — under the existing per-field whitelist discipline: absent,
malformed, or out-of-enum values drop the field, never coerce, never fabricate. Unknown keys keep
rejecting strict ledger input. Routes/journal schemas, sealed-archive shapes, and every existing
projection are otherwise unchanged; no historical record is regraded or rewritten.

### 3.5 Privacy, performance, and interpretation

The note adds a constant-length suffix to one stdin write. The watchdog is one timer object armed at
most once per run and cleared at settlement — constant memory, no polling loop (it re-arms on each
decoded frame only to extend its deadline). `HOME` redirection is one env assignment at spawn. No
new I/O, dependency, persistent state, network operation, or background worker exists in this
design.

Interpretation fences: the note changes what the worker is told, not what it does — a repeated wrong
refusal after this change is a recorded non-reproduction, not a contract violation. A stall abort
converts silent wall-clock into an earlier unjudged timeout; it never grades, never diagnoses, and
never establishes why the worker went silent. Hermetic `HOME` is a default-discovery closure, not
host-secret isolation. None of these fields is a gate on correctness, routing quality, billing, or
safety.

## 4. Connected implementation surface

This is a future implementation boundary, not implementation authorization. The later change must
cover all connected consumers in one contract:

| Surface | Required responsibility |
| --- | --- |
| `src/codex.ts` | `HOME`/`ZDOTDIR` to managed home; note constant + stdin append; stall watchdog on the existing abort ladder; `instructionNote`/`abortReason` on the receipt |
| `src/cli.ts` | `--stall-abort-ms` parsing/validation; unchanged exit semantics for a stall-aborted run |
| `src/task.ts` | Verify validation boundary untouched — note appended after validation, never inside it |
| `test/custom-round.ts` | Optional `stallAbortMs` roster field (prepare-time validation, manifest freeze); flag passthrough; stall→unjudged-timeout mapping at the existing decision position |
| `test/live-acceptance.ts` | Same passthrough and stall→timeout mapping; extended shared receipt projection |
| `test/worker.test.ts`, `test/codex.test.ts` | Environment hermeticity, note append/tag, watchdog arming/fire/never-on-zero-frames, ladder reuse |
| `test/cli.test.ts`, `test/custom-round.test.ts`, `test/live-acceptance.test.ts` | Flag validation, receipt fields, decision-order and unjudged-outcome regressions |
| `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (+ `.claude` mirror) | Hermetic `HOME` consequences, note + version tag, stall-abort semantics; keep passages aligned |
| `test/package.test.ts`, `test/init.test.ts` | Update only packaged-documentation assertions genuinely changed |

Use synthetic fixtures inside existing test helpers. No compatibility adapter, migration, config
version bump, or default-on behavior is introduced. Update exact-key/text assertions reached by this
contract; do not weaken security or coverage gates to make them pass. Avoid unrelated cleanup.

## 5. Acceptance criteria for later implementation

All criteria are offline; fake workers and fake classifiers make no real provider request.

1. **Hermetic home:** spawned worker env asserts `HOME` and `ZDOTDIR` equal the managed home and
   `CODEX_HOME`; parent process env unchanged; teardown removes the home; no staged dotfiles.
   A fake-worker descendant reading `$HOME` sees only the run's managed tree.
2. **Instruction note:** the stdin delivered to a fake worker equals
   `task + "\n\n" + NOTE` byte-exactly for both transports; classifier request body and
   `routes.jsonl` hash/length still describe the bare task; rejection paths (oversize, blank,
   continuation-only, NUL) are unchanged; receipt carries the version tag on every executed-worker
   path that appends it.
3. **Stall watchdog:** fake-worker timelines cover — fires after silence ≥ threshold post-first
   frame; never fires with zero decoded frames; re-arms on later frames; never fires after terminal
   event, shutdown start, or settlement; produces `abortReason: "stall"`, `ownedShutdown: true`, one
   `stall-abort` lifecycle event, and the existing SIGINT/grace/SIGTERM sequence; a caller signal
   arriving first keeps precedence and records no stall reason.
4. **Flag and roster validation:** `--stall-abort-ms` accepts 5000–3600000 and rejects absent-value,
   non-integer, out-of-range, and duplicate forms with usage exit 2; roster `stallAbortMs` validates
   at prepare, freezes into the manifest, and replays refuse on mismatch; absent field spawns no
   flag.
5. **Harness mapping:** in both harnesses a stall-aborted lone attributable receipt yields the
   unjudged `timeout` case outcome at the existing decision position, roster continues, no oracle or
   contract check runs; a stall receipt that is not lone/attributable follows existing stop rules
   unchanged. Projections retain/drop `instructionNote` and `abortReason` per whitelist rules with
   malformed and out-of-enum inputs.
6. **Privacy canaries:** no note prose, environment values, or path strings beyond the fixed tag
   reach journals, projections, or diagnostics beyond their defined fields; existing redaction
   surfaces unchanged.
7. **Regression commands:** build/typecheck, focused suites, full `pnpm test`, stock
   `pnpm test:coverage` with existing 80% gates, dependency audit, `git diff --check`, scoped-diff
   and README/skill alignment review. No live command belongs to this stage.

## 6. Next decision boundary and non-goals

The companion [execution plan](../plans/2026-10-19-worker-boundary-hardening.md) returns to the user
with this spec. Implementation and offline verification start only after the user's execution-method
decision; any live diagnostic needs a fresh finite manifest/SHA approval with explicit cases, caps,
predeclared stop rules, and matched controls, changing one variable at a time. Do not replay the
sealed campaign or reuse its authorities.

Excluded: classifier band recalibration and profile-minimum heuristics (policy hypotheses, owner
decision), routing-policy changes, retry/escalation of failed cases, proxy-exit attestation,
`AGENTS.override.md` and admin-hook closure, host-secret isolation beyond default discovery paths,
prompt caching, new diagnostics dashboards, and regrading historical cases.

## 7. Self-review record

Independent review: native `gpt-6-astra/high` worker through the local routing harness, read-only
review scope, reviewed the original spec commit on this branch. Verdict and disposition table are
recorded here after the review loop concludes; the review narrows the design and does not change any
historical grade or authorize implementation.
