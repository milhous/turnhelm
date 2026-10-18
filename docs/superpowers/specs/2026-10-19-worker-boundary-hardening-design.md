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

Alongside these, the repository's own boundary documentation (README residual list; the environment
code itself) records that "other shells' startup files" and "`$HOME/.agents/skills` discovery"
remain reachable because the child keeps the host `HOME` (only `ZDOTDIR` is redirected, which
covers zsh alone) — a documentation/code finding that motivates the first change below, not a
campaign-report observation.

Reading of the current code (all at the baseline): the task is delivered verbatim on stdin
(`src/codex.ts:44-55,178+`); the worker environment redirects `CODEX_HOME` and `ZDOTDIR` but not
`HOME`, and passes the remaining parent environment through (`src/codex.ts:57-90`); the CLI has no
internal deadline — only caller signals abort (`src/cli.ts:148-156`); `lastEventAt`/`progressEvents`
already exist as parent observations inside `executeWorker`; the owned shutdown ladder is SIGTERM to
the owned group, then SIGKILL after the fixed 1 s grace (`src/codex.ts:417-441`); `workerExit`
returns a positive child death code unchanged (`src/cli.ts:86-92`); the two harnesses do **not**
share one worker projection — custom-round projects every recognized status through
`projectWorkerReceipt` (`test/custom-round.ts:894-933`) while standard acceptance projects
`workerFailure` only for failed workers with a valid class (`test/live-acceptance.ts:1072-1089`).
This design hardens exactly three surfaces and nothing else.

## 2. Decision and scope

**Close the documented `HOME`-discovery residual, state sandbox semantics once in the worker
instruction, and make long silences abortable early — all as small, bounded, evidence-honest
changes.** No new subsystem, config version, retry path, or default behavior change enters through
this design.

| Alternative | Decision |
| --- | --- |
| Redirect worker `HOME` to the managed per-run home | Adopt: one env assignment closes `HOME`/`ZDOTDIR`-derived discovery with the run's existing teardown |
| Add a sandbox-semantics note to the worker instruction | Adopt: a fixed, versioned, English constant appended after task validation — the only observed wrong-refusal class is a sandbox-policy misunderstanding |
| Internal stall watchdog, opt-in (`run` CLI + custom-round roster) | Adopt: adaptive where a fixed deadline cannot be — fires only on measured silence after a decoded frame; default stays off |
| Wire stall abort into standard live acceptance too | Reject: its preparation path (`--config`, `--case` only) and manifest v2 case generation are frozen; adding a new manifest axis costs more than the rare 240 s stall it would save. Revisit as its own decision if a need appears |
| Scrub `XDG_*`/`GIT_CONFIG_*`/`NPM_CONFIG_*` and friends from the worker env | Reject: whack-a-mole against explicit override variables; keep the minimal redirect and scope the claim honestly instead |
| Raise fast tasks to balanced, refit band hypotheses, retry failures | Reject: calibration policy and outcome changes without diagnosed causes (report fences them) |
| Proxy-exit attestation, `AGENTS.override.md` closure, admin-hook isolation | Reject: not closable from this repository or requires unverifiable external proof |
| Prompt/content caching, dashboards, raw-event retention | Reject: no evidence need; privacy cost |

Unchanged: routing and classifier contracts, config v2 shape, task 8192-byte validation boundary,
managed `CODEX_HOME`/auth symlink lifecycle, sandbox selection per `--write`, output-schema staging,
payload framing, failure taxonomy and stop order, exactly-one-receipt behavior, terminal-event
settlement, `workerExit` rules, all consumer gates, exit codes, and sealed artifacts. No new
automatic request, escalation, or retry is added anywhere.

## 3. Normative contract

### 3.1 Hermetic worker `HOME`

`workerEnvironment` additionally sets `HOME` to the same managed per-run home as `CODEX_HOME`, and
points `ZDOTDIR` at that managed home instead of the project `.turnhelm` root (a host-exported
`ZDOTDIR` must still not win; the managed home is removed with the run exactly as today, so the
redirect dies with it). The parent CLI process environment is untouched, and every other inherited
environment variable keeps passing through as it does today.

The guarantee is scoped to **`HOME`/`ZDOTDIR`-derived discovery**: a worker shell or descendant that
resolves startup files, agent-skill directories, or dotfiles through `$HOME` (fish's
`$HOME/.config/fish`, `$HOME/.agents/skills`, `$HOME/.gitconfig`, `$HOME/.npmrc`, …) now finds the
run's empty managed home instead of the host's. That is also the behavior change: a write-mode task
whose worker must create commits now needs the identity stated in the task itself, and
registry-authenticated installs inside a worker require that authentication to arrive through the
task's own inputs. These consequences are documented, not mitigated with staged dotfiles — staging
host secrets back in would undo the closure. `TMPDIR`, the cwd project tree, and the
argv/instruction surface are unchanged.

Still open and still documented as residuals (deliberately not chased here): explicit override
variables such as `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, or `NPM_CONFIG_USERCONFIG`; system-level
startup files outside any home; managed/admin hook layers outside `CODEX_HOME`; a project
`AGENTS.override.md`; and absolute reads of host files by an authorized worker. Hermetic `HOME`
removes default discovery paths, not the host filesystem boundary itself.

### 3.2 Sandbox-semantics instruction note

After `validateTask` accepts the consumer's task, and only on the path that writes the worker's
stdin, the CLI appends one fixed English constant, so the worker instruction becomes
`task + "\n\n" + NOTE`. The classifier still receives the task alone; `routes.jsonl` task hashes and
lengths still describe the consumer's task. The note is a named constant with a version tag
(`sandbox-semantics-v1`) so evidence can identify the exact instruction generation without retaining
prose in receipts. Draft content — qualified to claim only what the runner actually controls, final
wording frozen before the byte-exact tests are written:

> Sandbox semantics (fixed runner note, not from the requester): a read-only sandbox denies writes,
> not reads — read-only mode itself never prohibits reading. A workspace-write sandbox additionally
> permits writes inside the workspace. Attempt to read the files the task requires as inputs, using
> your available tools, before answering — always respecting any read restrictions the task itself
> states. Distinguish an actually failed read attempt from a tool you do not have, and report a
> read as denied only when a real read attempt failed.

The consumer task-size limit still gates only the consumer's bytes; validation order and rejection
semantics are untouched. The executed-worker receipt carries the version tag
(`instructionNote: "sandbox-semantics-v1"`) as a mechanism attestation — the same honesty class as
`codexHomeManaged`, not a claim the worker obeyed the note. If the tag is absent, no note was
appended. This is a prompt-boundary mitigation for an observed twice-seen failure class, not a
guarantee: schema gates and consumer oracles remain the acceptance authorities, and a repeated
refusal after this change is a recorded non-reproduction, not a contract violation.

### 3.3 Opt-in stall abort

`turnhelm run` gains `--stall-abort-ms <integer>` (default absent = disabled; accepted range
5000–3600000, mirroring roster deadline bounds; rejected like any malformed flag with usage exit 2).
The custom-round roster case gains an optional `stallAbortMs` with the same validation, frozen into
the manifest at prepare; the runner passes it through as the CLI flag. Standard live acceptance is
untouched: its preparation surface and manifest schema stay exactly as frozen, its worker cases
never pass the flag, and a stall there keeps costing its ordinary deadline (§2 rejection row).
`test/live.integration.ts` gains no new flag.

Inside `executeWorker`, the watchdog arms only after the first successfully decoded frame and fires
only when all hold: no terminal event yet, no shutdown started, not finished, and
`now - lastEventAt >= stallMs`. A run with zero decoded frames never stall-aborts — absent evidence
is unknown, and a silent-from-birth worker stays under the consumer's ordinary deadline. On firing,
the watchdog records one `stall-abort` lifecycle event and starts the existing owned shutdown ladder
**unchanged** — SIGTERM to the owned group, then SIGKILL after the fixed grace, with the existing
discharge/settlement ordering and home teardown. A caller signal arriving first keeps its existing
precedence and records no stall reason. The run settles as a cancelled run does, and the worker
receipt gains `abortReason: "stall"` — present only on this path, absent on caller aborts —
alongside the existing `ownedShutdown: true`, `progressEvents`, and `lastEventAgeMs`, which already
describe the silence. No new failure class or status value is invented, and no stall-specific exit
normalization is added: the CLI process exit follows the existing `workerExit` rules unchanged, so
an owned-teardown death surfaces the child's observed death code (typically 143, or 137 after the
grace) — the same codes that class of run already produces today. Stall abort remains a
parent-observed action record, never a liveness or causation claim.

The `stall-abort` event requires its connected lifecycle surfaces in the same change:
`src/lifecycle.ts`'s `LifecycleKind` union admits it, and the shared lifecycle-kind whitelist the
harness projections validate against admits it — otherwise any timeline containing the event drops
whole, degrading both receipt and journal-fallback evidence. Recording still happens only when
lifecycle collection is enabled (`--lifecycle`), like every other event.

Custom-round maps a lone attributable receipt carrying `worker.abortReason: "stall"` to its existing
**unjudged timeout** outcome — the same semantics as an expired deadline, decided at the same
position in the existing decision order, before grading. Without this mapping an early-settled stall
would misgrade as a task failure; with it, a roster saves the silent remainder of its budget without
changing what the case proves. Timeout stays unjudged: no oracle, no contract check, the roster
continues. A stall receipt that is not lone or not attributable follows the existing stop rules
unchanged.

### 3.4 Evidence projections

The two harnesses' projections are not shared code and stay honestly separate. Custom-round's
`projectWorkerReceipt` whitelist admits exactly two new bounded per-field values —
`instructionNote` (fixed version-tag string) and `abortReason` (enum, `"stall"` only) — with the
existing per-field discipline: absent, malformed, or out-of-enum values drop the field, never
coerce, never fabricate; unselected keys keep being ignored exactly as that projector does today
(no strict unknown-key rejection exists on that path — its ledger serializes the projection
directly; the strict nested validators belong to standard acceptance's separate contract). Standard acceptance's
`workerFailure` projection is failure-only by design and gains nothing; its observed record instead
gains one optional bounded `instructionNote` field extracted from the receipt for every executed
worker regardless of status (completed, failed, cancelled), because the note is always-on and its
attestation must survive on passing cases too. `abortReason` is not extracted there — that harness
never passes the flag, and unextracted receipt keys already degrade per its existing rules.
Routes/journal schemas, sealed-archive shapes, and every existing projection are otherwise
unchanged; no historical record is regraded or rewritten.

### 3.5 Privacy, performance, and interpretation

The note adds a constant-length suffix to one stdin write. The watchdog is a single timer object —
armed at most once, its deadline extended as frames decode, cleared at settlement — constant memory,
no polling loop, no per-frame allocation. `HOME` redirection is one env assignment at spawn. No new
I/O, dependency, persistent state, network operation, or background worker exists in this design.

Interpretation fences: the note changes what the worker is told, not what it does; a stall abort
converts silent wall-clock into an earlier unjudged timeout — it never grades, never diagnoses, and
never establishes why the worker went silent; hermetic `HOME` closes default discovery paths, not
host-secret isolation. None of these fields is a gate on correctness, routing quality, billing, or
safety. Offline fixtures verify the mechanics and evidence contracts only — they cannot establish
reduced wrong refusals, and silence never proves a stall.

## 4. Connected implementation surface

This is a future implementation boundary, not implementation authorization. The later change must
cover all connected consumers in one contract:

| Surface | Required responsibility |
| --- | --- |
| `src/codex.ts` | `HOME`/`ZDOTDIR` to managed home (passthrough env otherwise unchanged); note constant + stdin append; stall watchdog driving the existing TERM→KILL ladder; `instructionNote`/`abortReason` on the worker result |
| `src/cli.ts` | `--stall-abort-ms` parsing/validation (usage exit 2 on malformed); receipt fields wired through the explicit receipt construction; `workerExit` untouched |
| `src/task.ts` | Verify the validation boundary is untouched — note appended after validation, never inside it |
| `src/lifecycle.ts` | `stall-abort` admitted to `LifecycleKind` under the existing recorder contract |
| `test/custom-round.ts` | Optional `stallAbortMs` roster field (prepare-time validation, manifest freeze); flag passthrough; `stall-abort` admitted to the shared lifecycle-kind whitelist; the two new `projectWorkerReceipt` fields; stall→unjudged-timeout mapping at the existing decision position |
| `test/live-acceptance.ts` | Shared lifecycle-kind whitelist admits `stall-abort` (timeline survival); optional bounded `instructionNote` on the observed record for every executed worker; no stall flag, no manifest change |
| `test/worker.test.ts`, `test/codex.test.ts` | Environment hermeticity (claimed paths only), note append/tag, watchdog arming/fire/never-on-zero-frames/re-arm, ladder reuse, caller-signal precedence |
| `test/cli.test.ts`, `test/custom-round.test.ts` | Flag validation; receipt fields; decision-order and unjudged-outcome regressions; lifecycle round-trip incl. journal fallback with a `stall-abort` event |
| `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (+ `.claude` mirror) | Hermetic `HOME` scope and residuals, note + version tag, stall-abort semantics and exit behavior; keep passages aligned |
| `test/package.test.ts`, `test/init.test.ts` | Update only packaged-documentation assertions genuinely changed |

Use synthetic fixtures inside existing test helpers. No compatibility adapter, migration, config
version bump, manifest version bump, or default-on behavior is introduced. Update exact-key/text
assertions reached by this contract; do not weaken security or coverage gates to make them pass.
Avoid unrelated cleanup.

## 5. Acceptance criteria for later implementation

All criteria are offline; fake workers and fake classifiers make no real provider request.

1. **Hermetic home, scoped claims:** spawned worker env asserts `HOME` and `ZDOTDIR` equal the
   managed home and `CODEX_HOME`; the existing `subprocessEnvironment` filtering (credential,
   `BASH_ENV`/`ENV`, coverage suppression) and managed-child overrides remain intact — only `HOME`
   and `ZDOTDIR` change; other inherited variables still pass through (including
   `XDG_CONFIG_HOME` when the host exports one); parent process env unchanged; teardown removes the
   home; no staged dotfiles. Synthetic hostile-host checks confirm the claimed-closed paths: a
   descendant resolving `$HOME/.config/...`, `$HOME/.agents/...`, `$HOME/.gitconfig` sees the
   managed tree only.
2. **Instruction note:** the stdin delivered to a fake worker equals
   `task + "\n\n" + NOTE` byte-exactly for both transports; classifier request body and
   `routes.jsonl` hash/length still describe the bare task; rejection paths (oversize, blank,
   continuation-only, NUL) unchanged; the receipt carries the version tag on every executed-worker
   path that appends it, and standard acceptance retains `instructionNote` on the observed record
   for completed, failed, and cancelled workers alike.
3. **Stall watchdog:** fake-worker timelines cover — fires after silence ≥ threshold post-first
   frame; never fires with zero decoded frames; deadline extends on later frames; never fires after
   terminal event, shutdown start, or settlement; drives the existing `shutdown-term`/`shutdown-kill`
   sequence with discharge ordering and home teardown intact; a caller signal arriving first keeps
   precedence and records no stall reason; the run settles cancelled with `abortReason: "stall"`,
   `ownedShutdown: true`, and the process exit follows existing `workerExit` rules (143/137-typical,
   no normalization). A `stall-abort` lifecycle event survives receipt projection and journal
   fallback through the extended whitelist.
4. **Flag and roster validation:** `--stall-abort-ms` accepts 5000–3600000 and rejects missing
   value, non-integer, out-of-range, and duplicate forms with usage exit 2; roster `stallAbortMs`
   validates at prepare, freezes into the manifest, and a replay refuses on mismatch; absent field
   spawns no flag; `test/live.integration.ts` flags are unchanged.
5. **Custom-round mapping:** a stall-aborted lone attributable receipt yields the unjudged
   `timeout` case outcome at the existing decision position, the roster continues, no oracle or
   contract check runs; a stall receipt that is not lone/attributable follows existing stop rules.
   `projectWorkerReceipt` retains/drops `instructionNote` and `abortReason` per whitelist rules with
   malformed and out-of-enum inputs; unselected keys keep being ignored (no new validator).
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

Excluded: stall abort in standard live acceptance (no prepare input path; frozen manifest axis),
environment scrubbing beyond `HOME`/`ZDOTDIR` (explicit override variables stay residuals),
classifier band recalibration and profile-minimum heuristics (policy hypotheses, owner decision),
routing-policy changes, retry/escalation of failed cases, proxy-exit attestation,
`AGENTS.override.md` and admin-hook closure, host-secret isolation beyond default discovery paths,
prompt caching, new diagnostics dashboards, and regrading historical cases.

## 7. Self-review record

Independent review: native `gpt-6-astra/high` worker through the local routing harness (Laya
classifier, direct transport; read-only sandbox; worker completed in 143522 ms, 46 decoded frames,
receipt byte-retained at the review root). Reviewed the original spec commit `598063c`. Verdict:
**PROBLEMS — 6 Important, 1 Minor**; the review confirmed the three mechanisms "reasonably small"
and the bare-task/classifier/route-hash preservation sound, and flagged no over-engineering beyond
the surfaces below. The parent verified the two load-bearing claims against the code
(`src/codex.ts:417-441` TERM→KILL ladder; `test/live-acceptance.ts:1072-1089` failure-only
projection) before revising.

| Review finding | Disposition in this revision |
| --- | --- |
| Spec named the wrong shutdown ladder (SIGINT→SIGTERM is the outer supervisor's; `executeWorker` owns TERM→KILL) | §3.3/§5.3 corrected to the actual ladder and its `shutdown-term`/`shutdown-kill` sequence |
| "Exit 1" contradicted unchanged `workerExit` rules (positive child death code stands) | §3.3 now preserves `workerExit` unchanged, documents the 143/137-typical exit, adds no normalization |
| Harness projections are not shared; standard acceptance drops attestations (failure-only, class-required) | §3.4 rewritten: custom-round whitelist gains both fields; standard acceptance gains a status-independent optional `instructionNote` on the observed record; `abortReason` not extracted there |
| `stall-abort` lifecycle event would collapse whole timelines (kind union + shared whitelist) | §3.3/§4/§5.3 include `src/lifecycle.ts` and both harness whitelists; recording still conditional on `--lifecycle`; journal-fallback round-trip required |
| Standard acceptance has no prepare-time input for `stallAbortMs` | Adopted as the over-engineering cut: standard adoption rejected outright (§2, §6); `live.integration.ts` unchanged |
| `HOME` closure overstated (override env vars, system files remain) | §3.1 claim scoped to `HOME`/`ZDOTDIR`-derived discovery; overrides/system files listed as residuals; env scrubbing rejected as whack-a-mole; hostile-dotfile tests limited to claimed paths |
| Note wording promised readability the runner cannot establish | §3.2 note reworded to mode semantics + attempt/distinguish/report-only-on-failure; wording frozen before byte-exact tests |

Second-round review: same worker class and harness against the revised spec (`0573fac`). Verdict:
**PROBLEMS — 1 Important, 3 Minor**; its notes verified all seven first-round dispositions
substantively correct and found no new blocking watchdog or timeout-order defect. Dispositions:
the note now respects read restrictions stated in the task itself (§3.2); acceptance criterion 1
keeps the existing `subprocessEnvironment` filtering intact so only `HOME`/`ZDOTDIR` change; the
custom-round projection text no longer claims a strict unknown-key rejection that path never had
(unselected keys stay ignored; §3.4/§5.5); and the residual-phrase attribution moved from the
campaign report to the repository's own boundary documentation (§1).

Third-round review: same harness against the qualified spec (`2ddb042`). Verdict: **ACCEPT, zero
findings** — the revisions verified against source, README boundary documentation, and the private
report; the spec judged internally consistent, contract-preserving, offline-testable, with "no
remaining over-engineering or under-engineering gap identified within scope" and behavioral
benefits explicitly unproven (as this spec states throughout). The review loop is closed at
PROBLEMS(7) → PROBLEMS(4) → ACCEPT(0).

No native worker/provider test request was made in any round. These reviews narrow the design;
they do not establish a task-failure cause, change any historical grade, or authorize
implementation.
