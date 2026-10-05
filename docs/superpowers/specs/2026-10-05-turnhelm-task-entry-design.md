# Turnhelm task entry routing design

Date: 2026-10-05
Status: design approved in discussion; written specification awaiting user review; not implemented

## Goal and scope

Make Turnhelm the direct entry point for a complete coding task. Laya or Jev
classifies its difficulty, Turnhelm selects one configured model and reasoning
effort, and one Codex worker executes it. Optimize token consumption per accepted
task without relaxing security or adding unnecessary coordination.

Use a stateless CLI with project-scoped `init`, `doctor`, and `run`. There is no
parent model that must first interpret or summarize the task. The first release
does not preserve the old CLI or configuration format. Historical validation
receipts remain historical evidence, not proof of this design's behavior.

Functional correctness and demonstrated token savings are separate acceptance
gates. A smaller model or lower effort is not automatically a net token saving.

## Architecture decision

| Approach | Assessment |
| --- | --- |
| Stateless task-entry CLI | Selected: one configuration snapshot, one logical classification decision, one worker, and no background state. |
| Persistent routing service | Rejected for the first release: adds process management, state, and a larger security surface without demonstrated benefit. |
| Codex Hook integration | Rejected as the core entry: depends on client events and trust, while the selected workflow starts directly at Turnhelm. |

The hot path is `preflight -> classify -> validate -> execute -> report`.
Classification may attempt two backends, but a successful decision is never
classified again before execution. `run` does not invoke `doctor` or perform a
preliminary health check.

`init` installs discoverable instructions; those instructions do not intercept
ordinary `codex` commands or change an existing session's model. Codex can select
a skill from its description, but this is not deterministic execution enforcement.
The executable `run` path is the routing boundary. See the
[official skill discovery documentation](https://learn.chatgpt.com/docs/build-skills).

## Fixed profiles and difficulty selection

All six profiles participate in ordinary automatic selection:

| Profile | Starter model | Effort | Intended distinction |
| --- | --- | --- | --- |
| `fast` | `gpt-6-luna` | `low` | Small localized work with clear requirements and acceptance checks. |
| `balanced` | `gpt-6.1-sol` | `medium` | Routine implementation and debugging with bounded scope. |
| `deep` | `gpt-6.1-sol` | `high` | Difficult but bounded debugging, review, and multistep reasoning. |
| `frontier` | `gpt-6-astra` | `high` | Very difficult work with ambiguity and interacting cross-system constraints. |
| `frontier_xhigh` | `gpt-6-astra` | `xhigh` | Demanding reasoning requiring detailed argument and verification across several constraints. |
| `frontier_max` | `gpt-6-astra` | `max` | Exceptional problems requiring the greatest single-worker reasoning depth. |

These bindings and distinctions are starting design choices, not an optimality
claim or proof of account access. Official guidance distinguishes Luna's focused
work, Sol's complex cost-sensitive work, and Astra's hardest end-to-end work; the
exact effort choices above require evaluation on representative tasks.
See [OpenAI model guidance](https://learn.chatgpt.com/docs/models) and
[model selection guidance](https://learn.chatgpt.com/docs/model-selection).

Each profile binds exactly one model and effort in project configuration. Profile
IDs are fixed; owners may deliberately change their bindings. The classifier
returns only a profile ID, never a model name, effort, command, permission, working
directory, or configuration patch.

Select the lightest profile that meets the task's requirements. Do not equate
prompt length, file count, or keywords such as "security", "architecture", or
"deep analysis" with maximum difficulty. Distinguish uncertainty, coupled
constraints, required verification, and consequences of an incorrect result.
Profile criteria are concise, shipped application data rather than a generated
planning prompt or an online model leaderboard.

There is no `--allow-max`, `allowMax`, profile-disable option, or other max-specific
gate. `max` is selected by difficulty like every other effort. Selecting it on
the initial decision is not a retry or an escalation. It grants no additional
filesystem or data-egress permission.

No profile is silently substituted, removed, or downgraded because local model
metadata is missing or stale. Metadata is diagnostic evidence, not a live
entitlement check; an actual Codex model-access failure stops execution.

## Project configuration and root selection

All commands share one root resolver. The default target is the current directory;
`--project <directory>` explicitly selects another. Canonicalize and report that
root. Do not silently walk upwards and write into a Git root or another monorepo
package. The same root determines configuration, installed instructions, and
Codex's working directory.

The only Turnhelm configuration source is `<project>/.turnhelm/config.json`.
Do not fall back to `TURNHELM_CONFIG` or a global Turnhelm configuration. This does
not disable Codex's own authentication or applicable security configuration.

The starter template is:

```json
{
  "version": 1,
  "routingTimeoutMs": 4000,
  "backends": {
    "laya": { "enabled": true, "url": "http://127.0.0.1:8765" },
    "jev": { "enabled": false }
  },
  "profiles": {
    "fast": { "model": "gpt-6-luna", "effort": "low" },
    "balanced": { "model": "gpt-6.1-sol", "effort": "medium" },
    "deep": { "model": "gpt-6.1-sol", "effort": "high" },
    "frontier": { "model": "gpt-6-astra", "effort": "high" },
    "frontier_xhigh": { "model": "gpt-6-astra", "effort": "xhigh" },
    "frontier_max": { "model": "gpt-6-astra", "effort": "max" }
  }
}
```

Require exactly the six profile IDs, correctly typed backend settings, and bounded
model identifiers and effort strings. Read configuration as a bounded regular
UTF-8 file of at most 64 KiB. Reject unknown configuration fields and
unsupported versions rather than interpreting old formats. Models must be
nonempty, at most 200 characters, and contain only letters, digits, `.`, `_`, `:`,
`/`, or `-`. Effort is one of `low`, `medium`, `high`, `xhigh`, or `max`; never
accept an arbitrary Codex argument or TOML fragment from configuration.

`routingTimeoutMs` is an integer from 100 to 30000 milliseconds. Its default is an
initial engineering budget, not a measured latency guarantee. Init preserves a
valid existing configuration and its bindings; it never copies credentials or
hosted authorization from elsewhere.

## Backend eligibility and classification

An eligible backend is configured and permitted to receive the task. Eligibility
is not proof of current connectivity:

- Laya requires `enabled: true` and a valid HTTP loopback origin. Its optional
  credential is `LAYA_API_KEY`; a server requiring it can still reject a request
  when the credential is missing or invalid.
- Jev requires `enabled: true`, `TURNHELM_ALLOW_HOSTED_JEV=1`, and a nonempty
  `TYPESAFE_API_KEY`. Init must not enable either hosted opt-in automatically.
  Key presence alone is neither authorization nor proof that authentication works.
- No eligible backend is a preflight failure. Do not run Codex or invent a default
  profile.

With both eligible, attempt Laya first and Jev only if Laya fails. With one
eligible, call it directly. Confirm runtime availability through that actual
classification request rather than probing both first. Do not persist a doctor
probe's result as future routing availability.

Use the existing System One choice protocol: `POST /v1/systemone`, with
`typed-decisions` for Laya and `jev-latest` for Jev. The request contains the exact
task text and six bounded choice criteria. Remove the old `direct` outcome and
fallback-profile behavior. Consume the documented `answers.route` choice; it must
be a string matching one of the six configured IDs. Never interpret returned
instructions as authority to alter execution.

Apply these bounds:

- Task text: at most 8192 UTF-8 bytes. Reject invalid UTF-8, NUL, blank input, and
  continuation-only text such as "continue" or "do the above" before any request.
  Preserve accepted text without trimming, truncating, or summarizing it.
- Classification response: at most 8192 bytes actually received, regardless of
  `Content-Length`. Read and decode incrementally; cancel and clean up rejected
  responses without exposing their bodies.
- One monotonic total deadline covers classification, response reading, and
  failover. With two backends, Laya receives at most
  `min(1000 ms, floor(total budget / 4))`; Jev uses only the remaining budget.
  With one backend, it receives the total budget.
- At most one application-level request per eligible backend. No parallel race,
  voting, repeated attempts, or extra model used for classification summaries.
- Timeout, connection failure, non-success status, redirect, malformed response,
  or invalid choice is a failed attempt. Exhaustion stops before Codex starts.
  User cancellation never triggers Jev failover or execution.

Laya accepts only origins at `127.0.0.1` or `::1`, without URL credentials, query,
or fragment. Requests must not follow redirects or divert loopback traffic
through an environment proxy. Jev uses the fixed HTTPS origin
`https://api.typesafe.ai` with normal certificate verification and no redirects.

Do not read repository files, chat history, or environment contents to build a
classifier context. Users should describe the task and reference project paths
instead of embedding long logs or source dumps. Explicitly authorized Jev receives
the supplied task; Turnhelm does not claim to remove every secret a user places
inside that text.

## Run and worker boundary

```bash
turnhelm run < task.txt
turnhelm run --write < task.txt
turnhelm run --project /path/to/project < task.txt
```

Stdin is the preferred input. A single quoted positional task is also supported;
supplying both nonempty piped task text and a positional task is a usage error.
An empty closed pipe does not count as a second task. Do not join positional
arguments or silently append piped input. Stdin reduces process-argument exposure but does not
make task content confidential from authorized classifiers or Codex.

Before contacting classifiers, check project configuration, task validity,
eligible backends, a Git worktree, and a resolvable compatible Codex executable.
Keep `init` and `doctor` callable even when run prerequisites are missing.

Resolve the worker executable once. Use an argument array with `shell: false`,
the selected project root, and the exact validated model/effort from the original
configuration snapshot. Send the original task through stdin; do not reread
configuration or classify again after inspection.

The first release targets Codex CLI 0.160.0 or newer and requires its documented
execution controls. Pin `--sandbox read-only` by default; only this invocation's
`--write` changes it to `workspace-write`. Do not use sandbox, approval, hook-trust,
or security-rule bypass flags. Preserve stricter applicable client restrictions.

Use `--ephemeral`, JSONL output, and per-invocation `agents.enabled=false` to keep
one worker rather than native multi-agent orchestration. JSONL and ephemeral
execution are described in the
[official non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode);
the agent control is documented in
[subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents).
One worker can still make multiple model turns and tool calls needed to complete
and verify its task. Turnhelm does not promise one inference request or a hard
execution-token budget.

Set `TURNHELM_MANAGED_CHILD=1` in the worker environment. Another `run` from such a
child is rejected before configuration loading or classification. Installed
instructions tell managed children to execute directly. This prevents accidental
recursion, not a hostile child deliberately removing the marker.

Strip `LAYA_API_KEY`, `TYPESAFE_API_KEY`, `TURNHELM_ALLOW_HOSTED_JEV`, and
`TURNHELM_CONFIG` from the worker environment, while preserving Codex's required
authentication. Do not copy authentication files. This is an environment boundary,
not a guarantee that secrets elsewhere on the host filesystem cannot be read.

Classification exhaustion causes no worker launch. Worker spawn failure, stdin
failure, model rejection, nonzero exit, and termination are controlled failures.
Preserve meaningful child exit status; do not accept exit zero as success if task
stdin was not delivered. Cancel the operation's owned processes on interruption.
Never automatically rerun with a different model, effort, or permission, and never
roll back user workspace files after partial execution.

## Output and token evidence

Parse worker events incrementally, not by retaining the conversation. Use a
bounded JSONL reader with a maximum 1 MiB event; protocol failure is reported
without an automatic rerun. Render completed agent messages to stdout and
diagnostics or tool progress to stderr. Tool progress exposes event type/status,
not raw tool inputs or results. Keep only bounded transport state and
normalized usage counters; do not save raw event streams as Turnhelm logs.

Emit a compact completion receipt to stderr containing selected backend and
profile, model/effort, backend attempt counts and outcomes, routing and execution
duration, worker status, and provider-reported usage. Do not include full task
text, response bodies, headers, credential values, or source-file contents in
diagnostic records. User-visible model output may contain project information;
redirecting it to a file is the user's deliberate action.

Retain reported input, output, cached-input, and reasoning-detail fields without
adding overlapping counts twice. Missing usage is `unreported`, never zero. If a
classifier does not expose usable token accounting, report Codex execution usage
and classifier request counts separately; do not label that an exact total for
the entire routed task. Do not fetch live pricing, estimate an undocumented token
count, or build a billing database.

A clean process exit means execution completed, not that the requested change
passed acceptance. Acceptance comes from task-specific checks or user review.
Ephemeral mode avoids Codex rollout persistence; it does not disable every client
cache, project artifact, or upstream provider's data handling.

## Init and installed instructions

```bash
turnhelm init --dry-run
turnhelm init
```

Install only within the selected root:

- A missing `.turnhelm/config.json` from the versioned starter template.
- `.agents/skills/turnhelm-routing/SKILL.md` and its `agents/openai.yaml`.
- One short versioned managed block in `AGENTS.md`.

Instructions name the `run` entry, self-contained task requirement, ordinary
automatic selection including max, separate write/hosted authorization, and the
managed-child rule. Detailed procedure stays in the skill, not in a long AGENTS
block. Do not place default `--write` or hosted authorization in reusable commands.
The installed skill must not tell an unrelated project to run `pnpm build` or
`node dist/src/cli.js` as a Turnhelm fallback. An unavailable installed entry is a
diagnostic issue, not permission to build that other project.

Use `<!-- turnhelm:begin v1 -->` and `<!-- turnhelm:end -->` as the owned markers
for the AGENTS block. Shipped skill Markdown and YAML carry a Turnhelm template
version comment; same-name files without that marker are unowned. Ownership
markers are not execution authorization. Validate markers before editing;
duplicates, unbalanced markers, unowned same-name skills, or differing installed
template contents are conflicts requiring review. An identical repeat is a no-op.
Do not introduce a persistent installation database: comparison with shipped
templates is sufficient, and unrecognized versions are conflicts rather than
automatic compatibility migrations.

Preserve all bytes outside the managed block, file modes, and line-ending style.
Preflight every target before any write, inspect existing path components with
`lstat`, and reject symlinked writable targets, nonregular files, or resolutions
outside the selected root. Dry-run reports a changeset without writing.

Use same-directory temporary files and atomic replacement per file. Install skill
and configuration before activating the AGENTS block. This is not a multi-file
transaction: report partial failure accurately and clean up only unchanged files
created and owned by that operation. Never recursively remove a user directory.
Detect concurrent edits before replacing a file.

Init does not install packages, initialize Git, start Laya, acquire credentials,
publish the package, write global settings, or claim a generated template proves
runtime readiness. Report installed artifacts and unresolved prerequisites
separately. Codex loads AGENTS guidance at session startup; instruction overrides
and size limits can mask installed guidance. Advise restarting an existing
session where needed, per
[official instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Doctor evidence levels

```bash
turnhelm doctor
turnhelm doctor --json
turnhelm doctor --probe
```

Default doctor is read-only and offline. Its checks are independent; missing or
invalid configuration must produce findings rather than one opaque exception.
Allow bounded, non-inference CLI version/capability queries, but never `codex exec`,
login, a model-access probe, or an automatic repair.

Report `pass`, `warn`, `fail`, `unverified`, or `skipped`, with stable check IDs,
sanitized evidence, and a suggested next action. Check:

- Selected root, Node version, Codex/Turnhelm entry resolution, required flags,
  Git worktree, and bundled assets.
- Config source, schema, all six bindings, timeout, and enabled backends.
- Credential presence and hosted authorization, never credential values.
- Skill location, metadata, managed AGENTS block, instruction overrides, and
  ascertainable discovery restrictions; semantic instruction conflicts may
  remain unverified.
- Local model/effort signals as advisory evidence. Missing, stale, or conflicting
  metadata must not become a false entitlement claim or silently alter routing.
- Backend reachability, actual authentication, and model access as unverified
  unless the corresponding explicit test establishes a narrower fact.

`--probe` makes at most one bounded synthetic choice request per eligible backend,
testing each separately rather than hiding Jev behind a successful Laya probe.
Each probe uses the configured classification budget. Jev still requires its
independent opt-ins and can incur classifier fees. Unauthorized backends are
skipped. Do not send the user's actual task, invoke Codex, or persist probe results
as routing state. A valid response proves only that this synthetic classification
succeeded then, not that every real task or selected execution model is available.

For init/doctor, exit zero means no failing checks; warnings and unverified live
capabilities remain explicit in the result. Exit one means failed prerequisites,
conflicts, probes, or writes; exit two means invalid invocation. `run` also uses
two for invalid input, one for controlled setup/classification/transport failure,
and otherwise preserves a nonzero worker exit status. A protocol or stdin failure
cannot become success merely because the worker exits zero.
Never label offline validation alone as live readiness or verified token savings.

## Components and distribution

Keep a small CLI dispatcher and focused configuration/project, classifier, worker,
and onboarding/diagnostic responsibilities. Reuse existing bounded response,
stdin-error, secret-scrubbing, and sandbox boundary protections where applicable.
Share root/config resolution and managed-block validation instead of duplicating
them. Keep old global config loading and fallback/profile-materialization modes
out of the new hot path; local Codex metadata belongs in diagnostics.

Bundle trusted configuration and skill templates with the built package and
resolve them relative to its module location, never project cwd or a movable
source-checkout symlink. Test a packed installation in an unrelated project
without access to the source checkout. Preserve `private: true` unless publication
is separately authorized; local/tarball installation does not require publishing.

Keep pnpm, the current Node runtime floor, and the existing hermetic coverage/audit
workflow. Add dependencies only for a concrete need. Do not add a daemon, gateway,
online model registry, model-generated task summary, task planner, route cache,
ensemble, automatic escalation, continuous-session manager, Hook installer,
Windows-specific automation layer, or automatic paid benchmark.

## Verification and benefit acceptance

Use TDD during implementation with temporary projects, homes, dummy credentials,
fake classifier responses, and fake Codex executables. Keep existing process-error
and credential-boundary regression coverage when changing the execution path.
Offline tests must not contact real Laya/Jev or start a real Codex model run.

Required cases include:

1. Exact six-profile template, frontier/high and normal automatic max selection;
   no max-specific flag, disable setting, or extra classification stage.
2. Both eligible backends, each sole backend, no eligible backend, unauthorized
   Jev, Laya success, and one Laya failure followed by one Jev attempt.
3. Shared deadline, body reading timeout, cancellation, redirects, declared vs
   actual body size, invalid UTF-8/JSON/choice, and zero worker launches on failure.
4. UTF-8 task limits, whitespace preservation, blank/continuation-only input,
   stdin/positional conflicts, and zero classifier calls on local rejection.
5. Immutable decision-to-execution binding, executable/root/sandbox arguments,
   native-agent disable control, ephemeral mode, secret stripping, recursion
   rejection before classification, spawn/stdin failures, and child exit status.
6. Bounded event parsing, partial/missing usage, no duplicate cached/reasoning
   accounting, controlled protocol failure, and no sensitive diagnostic records.
7. Init dry-run, identical repeats, user-content/CRLF/mode preservation, existing
   config, ownership conflicts, invalid markers, symlinked ancestors/leaves,
   concurrent edits, and truthful partial-failure cleanup.
8. Independent offline doctor findings, synthetic probe gating, no live model
   call or repair, stale metadata, and no cached probe-driven routing policy.
9. Explicit roots, paths with spaces, nested projects/worktrees, non-Git setup
   reporting, packaged assets, and clean installation outside this checkout.

Source coverage must remain at least 80% for lines, branches, and functions. Run
the hermetic tests/coverage, dependency audit, and diff checks before an
implementation completion claim. Unit/integration success is not benefit proof.

A separate, explicitly authorized small trial covers all six difficulty levels
and compares the same inputs, starting workspaces, permissions, client controls,
and acceptance checks against an owner-selected fixed model/effort baseline.
Record the attempted tasks, acceptance results, execution tokens, classifier
accounting coverage, request counts, and elapsed times, including failed attempts
and manual repetitions. Do not treat a failure's low usage as a saving. Do not
inflate the baseline by choosing a stronger preset than the owner's normal work.

Claim benefit only for the tested workload when routed consumption falls without
worse acceptance results. If classifier token accounting is unavailable, qualify
the claim as execution-token reduction with separately reported classification
requests, not an exact whole-task total. No savings percentage or backend
classification accuracy is established by this specification.

## Review and implementation gate

This commit records the approved design only. It does not implement the new
commands, install project artifacts, change global configuration, probe services,
execute models, or publish anything. The user must review the written
specification before an implementation plan is prepared. Implementation and paid
benefit trials require their own subsequent authorization.
