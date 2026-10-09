# Turnhelm task-entry validation record

Run baseline: merged `main`, `053d42d` (PR #1). This record separates offline
contracts, path-specific evidence from real invocations, and quality,
permission, and billing semantics that remain unverified.

- Usage instructions: [README](../../README.md).
- Approved historical design: [task-entry spec](../superpowers/specs/2026-10-05-turnhelm-task-entry-design.md).
- Completed execution plan: [seven-task plan](../superpowers/plans/2026-10-05-turnhelm-task-entry.md).
- Canonical instructions shared by packaging and `init`: [routing skill](../../.agents/skills/turnhelm-routing/SKILL.md).

## Retained offline acceptance evidence

The table below retains earlier acceptance results; it does not mean this
documentation worker re-ran coverage, audits, or independent review. The
merged baseline's offline CI passed.

| Check | Evidence and boundaries |
| --- | --- |
| Project config and task input | Six profile IDs, v1 config snapshot, strict field validation, 8192 UTF-8 byte input, and cancellation. |
| Classification and direct transport | Bounded responses, shared deadline, Laya first, the triple Jev eligibility gate, cancellation never fails over; classification failure starts no worker. |
| Single-worker lifecycle | Explicit argv/environment/sandbox, JSONL events, sticky failure, backpressure, partial usage, owned-group termination and sink cleanup. |
| `init` / offline `doctor` | Package-relative templates; dry-run, idempotence, conflict/race protection; independent read-only checks; doctor's inspection/probe cleanup after signal cancellation. |
| CLI / receipt | Current directory or explicit `--project`, no parent-config discovery; recursion refused; exactly one receipt once classification starts, none for earlier rejections; SIGINT 130 / SIGTERM 143. |
| Real packaged installation | Real tarball installed in an independent Git consumer with spaces in its path; 18 package entries, 13 installed-bin invocations; dual Node; checkout reads and HTTP requests forbidden, zero workers. |
| Full test suite | 2026-10-08: 317/317 on the new branch under Node 26.5.0 and again after the documentation changes below, with 0 failures/cancellations/skips; the earlier 317/317 under Node 22.8.0 is historical compatibility evidence. |
| Coverage | 2026-10-07: lines 95.82%, branches 89.52%, functions 95.58%; 2026-10-08 earlier recheck: 95.82% / 89.41% / 95.58%, each >=80%. |
| Dependency audit | `pnpm audit --audit-level high` passed on 2026-10-07 and again earlier on 2026-10-08, no known vulnerabilities. |
| Minimum CLI compatibility | Integrity, version/help, and local inspect passed against the actual official Codex 0.160.0 native binary; local 0.160.1 also passed. Proves version/flag evidence only. |

Node 22.8.0 is the minimum supported version and 26.5.0 the acceptance
environment; this is not a request to switch the user's default Node. The
packaging check is not an npm registry publish (`package.json` remains
private). No legacy global config, route bypass, or compatibility adapter is
retained.

## Repeatable offline verification

Run from the source checkout; do not mistake `pnpm build` for installing a
global bin:

```bash
pnpm install --frozen-lockfile --ignore-scripts
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV pnpm test
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV pnpm run test:coverage
pnpm audit --audit-level high
```

`test/live.integration.ts` only participates in compilation and is not
executed by the offline tests above. Do not run `pnpm run test:live`, a real
worker, backend probes, or paid benefit trials on your own initiative to
reproduce this record. `doctor --probe` also sends one synthetic
classification request per eligible backend; it is not equivalent to plain
offline doctor.

## 2026-10-08 authorized real invocations

All of the following used real services and the production CLI, with no mocks
or harness-driven retries; they prove only the listed paths, not six-profile
model entitlement, classification-quality benchmarks, or benefit comparisons.

| Scenario | Actual result and boundaries |
| --- | --- |
| Jev sole backend | Classification 707ms, selected `fast / gpt-6-luna / low`; real read-only worker 47013ms, exit 0, arithmetic answer correct. |
| Fallback path with Laya unavailable | Laya failed in 3ms → Jev succeeded in 921ms, 924ms total < 4000ms; real read-only worker 36714ms, exit 0, answer correct. Historical scenario from before the local service was started. |
| Real probe of both backends | `doctor --probe` made one request each to Laya/Jev, both returned a valid choice; whole command 1299ms, per-backend latency not recorded, zero workers. |
| Laya-success first path | Both backends eligible; an actual `run` selected `fast / gpt-6-luna / low` via Laya in 538ms; real read-only worker 42834ms, exit 0, answer correct. That run's request count was Laya 1 / Jev 0. |

The last two items belong to the same verification scope: Laya 2 / Jev 1
classification requests and one real worker in total. Not a parallel dual
classification, and not one worker executed once per backend. The temporary
consumer was left unmodified by the read-only worker and cleaned up
afterwards; main and the global Codex config stayed unchanged. The existing
local Laya stayed healthy, listening only on `127.0.0.1:8765`.

Laya 0.3.22 used the installed environment and cached `typed-decisions`,
CPU/bounded threads, running as a launchd job in the current login session;
no login/reboot autostart was installed, no privacy permissions widened, no
models re-downloaded. Offline loading and health evidence do not equal
successful routing of a real task.

## Earlier routing failure of the real documentation requirement

Earlier, on new branch `milhous/docs-routing-validation`, the README, skill,
and stale-document cleanup requirement with its complete execution boundaries
was submitted as one 6076 UTF-8 byte task to the actual production
`turnhelm run --write`; no preselected model, no shortened task, and no
change to the then-default six-profile config or the 4000ms deadline. Only
local Laya was allowed; Jev was not enabled.

- Result: **failed**. One Laya request attempt, 4002ms timeout; routing
  totaled 4003ms, CLI exit 1, exactly one receipt.
- `worker.status: "not-started"`, worker usage `"unreported"`; no profile
  selected, no paid Codex worker started, and no documentation written by
  that run.
- The temporary project config was removed after content verification; the
  existing Laya stayed healthy, no service restart.
- No automatic budget extension, hosted-gate enabling, model substitution, or
  retry. Health checks and earlier short-task successes do not guarantee a
  real requirement succeeds within the default deadline; that record did not
  determine the timeout cause and must not be attributed to model
  entitlement or cited as evidence of poor classification quality.

Documentation maintenance was continued by the parent session; later
documentation checks passing must not be recorded as routing success for
that attempt. Any additional hosted requests/retries required their own
authorization; earlier trials' permission was not carried over.

## Later authorized root-cause fix and real-requirement reverification

- Controlled diagnostics on the same complete request: ~4ms upload, Laya
  server-side inference 5473.54ms, exceeding the old 4000ms budget; another
  invocation of the same request took only 653ms. Latency genuinely varied;
  the specific cold-start, load, or caching cause was not proven.
- More importantly, without an explicit token window the checkpoint's
  1024-token default dropped 668 of 1543 state tokens, `truncated: true`.
  Extending the timeout alone could not fix judgments made on an incomplete
  requirement.
- Regression tests were written first, the old implementation's budget,
  window, and truncation-validation failures observed, then the shared
  classification boundary was fixed: Laya explicitly sends `max_len: 8192`;
  when usage is declared, its truncation flags must be own fields
  `truncated: false` and `state_tokens_dropped: 0`. The Jev envelope,
  eligibility, failover share, and cancellation rules were unchanged. The
  template budget became 10000ms; existing project configs are not rewritten
  automatically, and the budget is not a latency guarantee.
- The fixed production routing boundary, using the original 6076-byte task
  and the actual direct transport: selected
  `frontier / gpt-6-astra / high` in 1646ms; the backend reported input 1692
  tokens, state 1543, dropped 0, `truncated: false`. No worker or mock.
- The actual production CLI then used the same original task and the current
  default config: Laya attempt 1602ms, routing 1603ms, automatically
  selecting the profile above; one `workspace-write` Codex worker completed
  the README/validation-record alignment in 276592ms, exit 0; CLI exit 0,
  exactly one receipt, run request counts Laya 1 / Jev 0.
- This investigation and reverification totaled 6 real local classification
  requests (4 diagnostics, 1 routing-boundary reverification, 1 CLI run) and
  one real Codex worker; no hosted requests, automatic retries, preselected
  models, service restarts, or global config modifications. The temporary
  config was removed after verification.

The full test suite inside the worker did not pass: it reported 250 passing,
23 failing, including 21 loopback `EPERM`, a Node native assertion crash in
the CLI tests, and one permission-race case; the related offline tests
passed 102/102. The parent session independently reproduced the
`mode edit between inspection and apply is refused as a race` failure when
inheriting `umask 077`: the fixture was already 0600 at creation, so a
further chmod 0600 produced no mode change. Worker permissions were not
widened, unrelated cases not modified, and no additional paid worker added;
this does not equal the full suite passing inside the worker.

After the worker exited, the parent session re-ran the full tests and full
coverage in a normal shell environment: 321/321 both, zero
failures/cancellations/skips; latest coverage lines 95.84%, branches 89.63%,
functions 95.58%, all >=80%. The dependency audit found no known
vulnerabilities; skill structure validation, 9 Bash/zsh code blocks, 8 local
links, and README/config-template consistency checks passed. The existing
skill already contained the needed startup guidance; the worker's `.agents`
writes were blocked by the read-only policy, and no permissions were widened
nor the skill — already accepted for these scenarios — overwritten for this.

This product fix touched only `src/systemone.ts`, `assets/config.json`, and
`test/task-routing.test.ts`, plus aligning the README/this record; the
earlier documentation cleanup is retained, and the current 10-05 plan/spec,
skill/UI metadata, six-profile bindings, global config, and Laya job are
unchanged.

The receipt still reports `classifierUsage: "unreported"` and
`wholeRunUsageScope: "unverified"`; the classifier token data above came
from the separate real routing-boundary reverification, not from the CLI
receipt's usage or whole-run costs.

## This round's dynamic-routing acceptance: real paths and remaining gaps

The user authorized full verification as in normal use, with at most three
additional retries for unexpected failures. This round used the current
production `init`, `doctor`, and `run` only in an independent temporary Git
consumer, with the actual Laya/Jev and installed Codex 0.160.1; no forced
profiles, fabricated classification answers, or internal worker interfaces
impersonating dynamic routing. Expected rejections, timeouts, and
cancellations count as passes with correct behavior, not paid retries.

**38 acceptance results were recorded: 34 passed, 4 failed**; six useful
tasks plus three authorized retries totaled **9 actual Codex workers**, all
completed with worker/CLI exit 0. Worker completion does not mean all
acceptance conditions passed: all four failed results are retained and were
not overwritten by later successes.

| Real scenario | Result and evidence boundaries |
| --- | --- |
| Installation, offline checks, and pre-classification rejections | 26 passes: dry-run/idempotence/owner-text preservation and valid custom config, offline doctor, UTF-8/byte boundaries/invalid arguments, no parent-config discovery, recursion refusal, Jev gates, Git precondition, and stdin SIGINT/SIGTERM. Zero classifications, zero workers. |
| Real Laya timeout and cancellation | A 100ms local budget produced a timeout; SIGINT after a real Laya TCP connection was established produced cancelled/exit 130. One receipt each, zero workers, zero Jev; client cancellation does not prove server-side inference stopped. |
| Dual-backend local-success-first, read-only stdin | Laya 340ms → `balanced / gpt-6.1-sol / medium`; worker 69534ms, answer correct, file bytes unchanged, Jev request count 0. |
| Jev sole-backend interval-merge implementation, write permission | Same complete task on the first attempt and three retries, naturally selecting fast/balanced/fast/balanced in turn; the parent's immutable tests passed 12/12 each time, with only the allowed artifact changes. But the additional shell-environment checks all failed; see below. |
| Laya sole-backend async-ledger implementation, write permission | routing 1657ms → `frontier / gpt-6-astra / high`; worker 120767ms; parent's immutable tests 8/8, only the two queue/ledger implementation files changed. |
| Hosted fallback after connection failure, read-only audit | Temporary config pointed at a confirmed-unlistened loopback port; Laya failed 3ms → Jev succeeded 677ms, routing 680ms; `frontier_xhigh / gpt-6-astra / xhigh`, worker 345705ms, independent contract check passed, zero file changes. The user's Laya was not stopped. |
| Real local worker control-boundary audit | Laya 984ms → frontier/high, worker 369819ms; independent contract check passed, zero file changes, and the two real teardown defects below were found. |
| Complete current acceptance requirement, dual-backend read-only report | 8014 UTF-8 bytes, task not shortened; Laya timeout 1002ms → Jev success 693ms, routing 1695ms; frontier_xhigh/xhigh, worker 676588ms. Report and file immutability verified by the parent; that source snapshot predates the worker fixes below and is not a post-fix live proof. |
| Real dual-backend doctor probe | One synthetic request each to Laya/Jev, both passed, zero workers; not evidence of a useful task or model access. |

This round totaled **7 actual Jev requests** (6 run, 1 probe) and **8 Laya
client attempts** (7 run, 1 probe), one of which was the connection failure
to the unlistened port above and must not be counted as the service actually
receiving a request. Health GETs do not count as classifications. No valid
selection was retried to fill in profile coverage. Actual completed receipts
naturally cover fast, balanced, frontier, and frontier_xhigh; **actual
access to deep and frontier_max remains unverified**.

### Environment-check failures and targeted cleanup

- The interval task first produced no environment-verification artifacts;
  the three retries switched to a helper that always outputs boolean
  observations, and all found `TYPESAFE_API_KEY` present in the normal
  worker shell, so they still failed. The complete classification task's
  bytes were unchanged; the helper's observability fix and the first failure
  are both retained.
- Actual Codex **process-environment** observation proved the four sensitive
  variables deleted and the managed marker set to 1; an independent control
  with no model calls proved `zsh -lc` reintroduces the Jev key, while
  zsh/bash controls that do not read startup files do not. The host
  `.zshenv` contains that variable name. All observations saved booleans
  only and never printed key values; no startup files, authentication, or
  shell defaults were modified. Process-environment stripping is not host
  filesystem secret isolation, and this risk must not be recorded as
  passing.
- During the actual workspace-write executions, the global Codex config
  gained five trust entries for this round's temporary projects. With the
  user's separate authorization, only those five entries were removed;
  re-verification confirmed all other TOML values identical, permissions
  still 0600, and all five entries absent. The file's original byte hash was
  not restored to this round's starting value; no claim of whole-file byte
  restoration is made, and the cleanup scope was not widened.
- The existing Laya kept PID 55374, launchd runs 1, healthy and listening
  only on loopback; the service was not restarted, no models downloaded, no
  privacy permissions changed. Temporary projects and redacted evidence
  remain in a private archive.

### Worker defects found by acceptance, and regressions

Both defects in `src/codex.ts` were reproduced before being fixed: after an
existing protocol failure, child close, and process-group cleanup, a late
cancellation did not re-drive settle if accepted writes still lacked
callbacks; after shutdown the stdout handler kept concatenating retired
frames, allowing an unbounded buffer during TERM grace. The regressions
prove both late message/diagnostic cancellations hang, and that a real
TERM-resistant fixture flood retained 2621440 bytes.

The production fix is threefold: shutdown clears the frame; subsequent
stdout chunks are dropped but the pipe keeps draining; onAbort re-settles.
No API, argv, profile, failure-priority, backend-policy, or client-config
changes. Three new regressions use real controlled subprocesses/process
groups; late cancellation is triggered jointly by child close and group
ESRCH, not by guessing timing with fixed sleeps. Private baseline
diagnostics allowed proving the two lifecycle-phase hangs even after cold
start; the tracked anti-hang limits are unchanged. The initial flood
backpressure and private observer escaping-error failure logs are retained
and not counted as valid RED. The final focused run passed 3/3 with
independent review finding no Critical/Important/Minor findings.

The latest complete **serial** coverage verification is **324/324, zero
failures/cancellations/skips**; lines 95.67%, branches 89.74%, functions
95.58%, all meeting the 80% global thresholds. The dependency audit found
zero known vulnerabilities; skill structure validation passed. Using the
original build and coverage options plus `--test-concurrency=1`, with no
tests deleted and no assertions relaxed. The default-parallel and early
serial coverage failure logs are retained. Default `pnpm test` on the first
attempt and three retries scored 319/324, 320/324, 323/324, 321/324; three
pre-existing fixture checks still failed at the end, and this must not be
passed off as the default command passing. A local temporary shebang script
once took 3139ms to first stdout after a successful spawn, exceeding the
original 2500ms fixture watchdog; an independent control reproduced the
startup-phase delay, and the underlying OS cause is unproven. There was
also a fixture timeout of the pre-existing 2000ms preflight inspection; no
production budgets were increased and no unrelated tests changed. One
serial pass does not let you infer the default parallel tests are stable on
this host.

The private archive `turnhelm-dynamic-acceptance-9po9nun9` holds the
manifest, complete tasks and hashes, results, each run's
stdout/stderr/receipt, parent artifacts/tests, RED/GREEN, coverage,
environment boolean observations, and the targeted-cleanup record. Only the
necessary `src/codex.ts`, existing worker tests, and this record were added;
the earlier README/skill/routing fixes and documentation cleanup are
retained, main unchanged, nothing published. This round's conclusion is
**representative real paths and the listed fixes are verified; it cannot be
signed off as "all real scenarios pass"**.

## Documentation and skill maintenance boundaries

- README, the shared skill, and this record were updated; the superseded
  2026-10-02/03/04 old-design and old-interface validation documents were
  removed — history is recoverable from Git.
- This documentation worker did not modify the 2026-10-05 task-entry
  plan/spec, product source, tests, dependencies, UI metadata, template
  markers, or auto-discovery policy; others' existing modifications were
  preserved.
- The 317/317 offline baseline and the independent reference scenario were
  completed first: the old skill could not provide offline/loopback startup
  instructions for an installed Laya, then per `skill-creator` that guidance
  and the real-requirement acceptance method were added. Structure
  validation is not a substitute for real application-scenario validation.

Offline recheck of the earlier documentation maintenance: `skill-creator`
structure validation passed; independent scenarios could correctly derive
from the new skill the existing venv's offline/loopback startup, the current
requirement's single execution, separate write/hosted authorization, and
the receipt/cost boundaries. Independent source and evidence review found
no substantive issues. 9 shell code blocks passed Bash/zsh syntax checks, 8
local Markdown links resolve, and the README config matches the asset
template. The actual README source-checkout shell function completed 6
init/doctor invocations in a temporary space-containing Git consumer,
verifying dry-run, idempotence, user AGENTS preservation, exact
skill/metadata copying, and no parent-config discovery; using the actual
Codex 0.160.1 version/help, the fetch-refusal guard recorded zero requests
and zero workers. These checks still do not represent successful routing
of the current requirement.

## Still unverified

- Actual access to `deep / gpt-6.1-sol / high` and
  `frontier_max / gpt-6-astra / max`, not naturally selected this round.
- Runtime semantics of Codex config keys such as `agents.enabled`; help/
  argument-passing evidence is insufficient.
- Laya/Jev classification quality on general real requirements; this
  documentation task's success path is not a quality benchmark.
- Whole-run usage aggregation and real costs/benefits. Codex uses ChatGPT
  login, which is not proof of API-key metered billing; worker snapshots
  are not invoice amounts.
- With no worker usage it is `"unreported"`, `classifierUsage` is
  `"unreported"`, and `wholeRunUsageScope` is `"unverified"`; these must not
  be zero-filled or converted into savings percentages. A fixed-model paid
  comparison still requires separate owner approval.
- Automatic restart behavior after a launchd-injected crash; no destructive
  testing was done this round.
- Secret isolation after the host shell rereads the Jev key, and the
  cold-start stability of the default parallel tests.

## 2026-10-08 post-merge dual-chain service reverification

This run created a normal branch `feat/paid-chain-validation` from the
squashed `dc9ee9c7f224e424c54c72a18c5ac65b15fac2c7`, reusing the existing
checkout, creating no workspace/worktree. It used the currently built normal
`init`, offline `doctor`, and `run` CLI; the real Codex was **0.161.0**,
Node 26.5.0, and the existing Laya is CPU `typed-decisions`. The user
separately authorized one run per chain, with Jev receiving a complete
sensitive-data-free test task; Jev and the single-process hosted opt-in were
enabled only for the private test project. The six profiles and the default
10000ms routing budget were unmodified, with no forced profiles, `--write`,
extra probes, automatic paid retries, or the classifier-only 48-request
`test:live`.

The two tasks used the same integer-amount coupon rule and eight boundary
inputs, differing only in the result marker. The parent independently
computed the oracle and verified stdout as complete, unique, exactly
matching JSON:

| Real full chain | Natural selection | routing | worker | CLI / worker exit | Business cases |
| --- | --- | --- | --- | --- | --- |
| Laya → Codex | `frontier / gpt-6-astra / high` | 5621ms | 64762ms | 0 / 0 | 8/8 |
| hosted Jev → Codex | `fast / gpt-6-luna / low` | 1398ms | 62305ms | 0 / 0 | 8/8 |

Both were `routing.status=selected`, `worker.status=completed`, one receipt
each. This round totaled **1 classification request** each for Laya/Jev and
**2 Turnhelm worker launches**, with no timeouts or retries. Each stderr
carried two generic `tool-progress` lines; they prove neither actual tool
nor internal API request counts, nor the runtime semantics of
`agents.enabled`. All observed owned process groups exited; the two private
projects' file hashes/permissions, product sources and build outputs, and
the global Codex config hash/0600 permissions were unchanged. Only this
record was appended; nothing committed or pushed.

Worker usage snapshots, in input/output/cached/reasoning order: Laya
`18219 / 234 / 8064 / 131`, Jev `18219 / 101 / 6912 / 0`. The current Codex
uses **ChatGPT login, not API-key billing evidence**; `classifierUsage`
remains `"unreported"` and `wholeRunUsageScope` `"unverified"`; invoices,
actual charges, and whole-run totals were not reconciled and must not be
converted into cost/savings ratios.

The conclusion is **both real service chains and the read-only business
results pass on the current version** — not six-profile, classification-
quality, or billing acceptance. The same-rule tasks selected differently
across Laya/Jev; no model changes or reruns to fill profile coverage, and
the pre-existing shell secret-isolation risk and other unverified items do
not disappear because of this pass. The private archive
`turnhelm-paid-chain-validation-ujgpefwm` holds the complete tasks, oracle,
invocation logs, receipts, the anti-double-start journal, file/config
seals, and verification results.

## 2026-10-09 documentation worker: actual changes and check boundaries

This section records only what this documentation worker itself did; the
parent's dynamic-routing receipt for it, the worker's final exit code,
usage, and full task acceptance must be recorded independently after the
worker exits. Last night's dual-chain results, earlier failures, and
historical statistics are not counted as this run's results.

- Read the local `skill-creator/SKILL.md` and `references/openai_yaml.md`,
  reviewing the trigger description, duplicate prompts, authorization, and
  secret boundaries per the narrow-scope update principle for existing
  skills; did not re-init the skill, invoke generators, or add references,
  policy, icons, or dependencies.
- First verified `src/assets.ts`, init/doctor, config/routing/systemone/
  Codex, and the live harness consumers via CodeGraph, then compared against
  the originals. What was actually written is the README and this section:
  tightened complete-input, project-config, single-worker, in-budget
  fallback, authorization, and cancellation wording, distinguished initial
  process environment from host secrets, and separated offline doctor,
  probe, run, and the 48-request-limit classifier-only `test:live`; linked
  the existing 0.161.0 dual-chain evidence, with the minimum still 0.160.0.
- **Skill modifications were not written**: editing
  `.agents/skills/turnhelm-routing/SKILL.md` was rejected by the current
  sandbox's protected-path policy (`writing outside of the project;
  rejected by user approval settings`). No bypass via the `.claude` symlink,
  no widened permissions. The parent still had to complete the approved
  skill update; the existing UI fields are accurate and metadata unchanged.
- Local Python 3.14 / installed PyYAML 6.0.3 each ran skill-creator's
  `scripts/quick_validate.py`; both the shared source and the Claude symlink
  entrance printed `Skill is valid!`, exit 0; what was validated is **the
  existing skill that could not be modified**, not a successful update.
- Using the installed MarkdownIt/PyYAML on the three Markdown documents:
  12 fenced blocks closed, 8 local links resolve, 9 shell code blocks pass
  Bash/zsh syntax checks, 3 JSON blocks parse; the README config matches
  `assets/config.json`. Template v1 markers, existing required UI fields,
  default auto-discovery, and the shared symlink target are all preserved.
  These are structure/syntax checks, not shell-example execution or
  independent skill behavior acceptance.
- Read-only invocations of the current build's template reading and
  installation inspection confirmed the shared template bytes match and the
  existing installation has no pending writes; a synthetic sentinel
  environment checked the four-variable deletion, unchanged original input,
  and the managed marker, and synthetic selections checked
  read-only/workspace-write argv. All passed, with no worker started, no
  classification requests, and no host key values read.
- This subprocess did not run the full `pnpm test`, coverage, dependency
  audit, probe, live harness, or another paid worker; the full default
  tests/coverage were left to the parent. The user-provided existing local
  337/337 and push/PR/main CI results are historical evidence and are not
  counted as new passes this time.
- Work-state read/write tools were both rejected by the current
  `approval policy: never`; no approval bypass. No modifications to source,
  tests, template config, dependencies, historical design/plan, AGENTS,
  temporary project config, global config/auth, startup files, or services;
  nothing committed, pushed, branch-switched, or delegated to agents.
- Before delivery, verified the SHA-256 of the original validation
  document's 21618-byte prefix is exactly identical (including the existing
  final 37 lines), and the other baseline tracked files, AGENTS, temporary
  config, and symlinks unchanged; branch/HEAD kept their original values,
  and `git diff --check` passed.

## 2026-10-09 current documentation-requirement dynamic routing: parent acceptance

This run, on the original `feat/paid-chain-validation` checkout at baseline
`dc9ee9c`, submitted the **5937 UTF-8 byte complete README, skill-creator,
and related documentation maintenance requirement** — under the user's newly
confirmed write and hosted/data authorization — to a normal `run --write`,
not a shortened smoke. The temporary project config enabled both backends,
still with the default 10000ms total budget and the original six profiles;
no forced profiles, extra probes, `test:live`, or paid retries. The
anti-double-start journal, original task, and hashes are archived.

The parent re-parsed the single receipt from actual stderr:

| Classification attempt | outcome | duration |
| --- | --- | --- |
| Laya (normal local-first budget share) | `timeout` | 1002ms |
| Authorized hosted Jev | `success` | 1034ms |

Total routing **2037ms**, natural selection
**`frontier_xhigh / gpt-6-astra / xhigh`**; the actual Codex **0.161.0**
worker was `completed`, 417899ms, exit 0, CLI exit 0. This round had exactly
**1 real Turnhelm worker launch**; the receipt's client attempt counts were
Laya/Jev 1 each; no harness retries, outer timeouts, or forced kills, and
all observed owned process groups exited. Client counts and generic
tool-progress prove neither server receipt, internal call counts, nor
billing.

**Routing and worker execution passed, but the worker's delivery on the
original complete task was only partial.** The parent checked the actual
four target files: the README and the previous section's 40 lines were
written; the skill/metadata were still byte-identical to baseline at that
time. The worker explicitly reported `.agents` writes rejected by the
protected-path policy and did not bypass the symlink or widen permissions;
exit 0 must not be recorded as full acceptance of the documentation
requirement.

The parent then completed the canonical skill within its own existing
permissions and approved scope: tightened the trigger scope, removed
duplicate prompts, and clarified initial-environment stripping versus host
secrets/protected paths, authorized in-budget fallback, the four check
kinds, and billing evidence boundaries. This was not a worker rerun or a
subprocess-sandbox modification. The UI description was already accurate;
metadata, default auto-discovery, and the Claude shared symlink are
unchanged, with no new resources or policy.

The parent independently executed and read current results this time (not
historical CI):

- skill-creator `quick_validate.py`: both the updated canonical and the
  Claude symlink entrance print `Skill is valid!`, exit 0.
- Markdown/YAML/JSON, local-link, and Bash/zsh syntax checks passed: 12
  closed fences, 8 local links, 9 shell blocks, 3 JSON blocks; the README
  config exactly matches the asset template. This is not equivalent to
  executing every shell example or adding independent skill behavior
  trials.
- While the temporary installation still existed, the current real CLI
  `init --dry-run` and offline `doctor --json` both exited 0; template
  bytes, no pending writes, synthetic four-variable stripping, and both
  sandbox argv checks passed, with no classification requests or real
  workers. The parent's first synthetic argv check failed due to an
  expected-argument-order mistake; after correcting the check against the
  unmodified source it passed, the failure evidence retained — not a
  product fix or paid retry.
- Unmodified `pnpm test` and `pnpm run test:coverage` each **337/337**,
  fail/cancel/skip all 0; no reduced default parallelism and no
  test/timeout modifications. Coverage: lines **95.67%**, branches
  **89.64%**, functions **95.58%**, all meeting the original 80% gates.
- `pnpm audit --audit-level high` exit 0, no known vulnerabilities found.
- The original validation document's **21618 bytes** (including last
  night's 37 lines) and the worker's appended record are preserved as a
  complete prefix. Only the newly created root project config and AGENTS —
  with dev/ino/hash/mode all matching exactly — were deleted, then the
  empty owned `.turnhelm` directory removed; no recursive cleanup. The
  other 44 tracked items, 13 compiled sources, global Codex config
  hash/0600 permissions, and all refs/worktree registrations unchanged.

This run's worker usage snapshot was input/output/cached/reasoning
`1044503 / 13690 / 888192 / 3269`. The existing **ChatGPT login** does not
prove API-key billing; `classifierUsage="unreported"` and
`wholeRunUsageScope="unverified"`; invoices, actual charges, and benefits
unverified, and this does not sign off full six-profile access, general
classification quality, host secret isolation, or automatic writability of
protected paths. The review phase added no real classification/worker runs
and modified no product source; nothing committed or pushed.

The archive `turnhelm-docs-skill-routing-cjsrm2bw` retains the complete
task, invocation journal/logs, receipt, before/after worker images, the
parent's first check failure and corrected result, test/coverage/audit
logs, and the exact cleanup and file/config seals. The final conclusions
are recorded separately: **dynamic-routing execution passed; the single
worker's complete delivery was partial; the parent-completed README/skill/
related records and the offline verifications above passed**.
