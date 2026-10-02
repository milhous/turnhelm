# Turnhelm routing design

Date: 2026-10-02

## Decision

Build a local-first TypeScript CLI on Node.js 22+ in two phases. Phase A routes
one task before starting `codex exec`. Phase B keeps the native Codex TUI and
routes only the **subagent spawn calls that Codex has already decided to make**.
It uses a synchronous `PreToolUse` Hook matching Codex's documented `Agent`
alias for `spawn_agent`. The Hook may add an allowlisted `model` and reasoning
effort to an otherwise unspecified spawn; it never decides whether to spawn,
how many agents to spawn, which roles to use, or when to wait.

This preserves the existing orchestration topology: no new subagent is created
for a prompt that Codex would have handled itself, and explicit parallel or
role-based delegation remains under Codex's control. The intended change is
compute selection for an existing spawn, not delegation policy or main-thread
model selection.

Do not modify Codex CLI/TUI source, add a Codex API, manage Codex credentials,
write `~/.codex/config.toml`, or configure an inference proxy. Both phases
inherit the user's existing Codex provider, authentication, policies, and
other configuration. Backward compatibility is not a design goal.

## Invariants and scope

- Routing input is the subtask text carried by a recognized `spawn_agent` tool
  argument in Phase B, or the submitted task text in Phase A. Turnhelm does not
  read the repository or a session transcript merely to classify a task.
- A route is `direct` or one profile ID from a small allowlist. Each profile
  maps to a fixed `model` and `effort` pair. Classifier output can select only
  an allowlisted profile; arbitrary backend strings are never passed to Codex.
- Configuration lives at `$HOME/.config/turnhelm/config.json`; `TURNHELM_CONFIG`
  selects an explicit test file. It contains `backend` (`laya` or `jev`), a
  loopback `layaUrl`, up to four profiles, and an optional `fallbackProfile`.
  Profile descriptions are at most 80 characters. Jev uses `jev-latest` and
  `TYPESAFE_API_KEY`; Turnhelm never stores that key. Laya may use
  `LAYA_API_KEY`.
- Jev and Laya share one narrow HTTP decision client using their real
  `/v1/systemone` endpoints. Normalize only the selected choice and required
  usage/latency data. Do not transfer confidence thresholds between Jev and
  Laya.
- Prompt text, tool arguments, and backend output are untrusted. Never log
  raw prompts, tool arguments, backend text, or credentials. Hook developer
  output is a fixed template containing only validated profile values.
- Phase B has **no** `UserPromptSubmit` Hook. It must not inject a developer
  instruction into every turn and must not mandate one subagent.
- Phase B must not change spawn count, parallelism, `agent_type`, task message,
  fork behavior, sandbox, approval policy, or explicit model/effort settings.
- If the installed Codex version exposes a different `spawn_agent` argument
  shape than the tested adapter, the Hook passes the call through unchanged.
  It does not guess field names or rewrite an unrecognized object.

## Phase A: single-task CLI

`turnhelm codex "<task>"` loads the route configuration, calls the selected
real decision backend, validates the profile, then starts `codex exec` with a
one-run model and reasoning-effort override. It passes the original task over
stdin/argv safely, does not use `--ignore-user-config`, and leaves login,
sessions, tool permissions, and provider selection to Codex. It defaults to
read-only execution; `--write` requests `workspace-write`, never unrestricted
access.

Phase A may use `fallbackProfile` for an unavailable classifier. A short
continuation or a prompt over 2,000 characters uses that fallback before a
backend call; with no fallback it exits before Codex starts. These conservative
rules apply only to Phase A's explicit command, not to Phase B's existing
spawn calls.

Phase A remains available throughout the Phase B pilot and after user-level
Hook promotion. A successful Phase B trial does not automatically replace it:
Phase B cannot route a task that the main thread handles without spawning, and
Phase A remains useful for scripts, CI, explicit preflight routing, and
environments where Hooks are disabled or untrusted.

The spawned Codex process removes only classifier-specific environment keys
(`TYPESAFE_API_KEY`, `LAYA_API_KEY`, and `TURNHELM_CONFIG`); it does not alter
Codex authentication keys or configuration.

## Phase B: spawn-time model/effort augmentation

### Trigger

The first trial installs only a project-local Hook in this repository. The user
reviews and trusts it through `/hooks`. The Hook is configured as:

- event: `PreToolUse`
- matcher: `^Agent$` (the documented matcher alias for `spawn_agent`)
- handler: synchronous command, five-second timeout

There is no `UserPromptSubmit`, `Stop`, `PostToolUse`, `PermissionRequest`, PTY
interception, App Server client, daemon, or custom TUI.

### Adapter contract

Codex's public Hook documentation identifies the `Agent` tool path and permits
`updatedInput` for local function tools, but does not publish a stable complete
`spawn_agent` argument schema. Therefore the implementation first records a
sanitized key/type shape from the installed Codex version in the validation
report. The committed adapter supports only that observed shape and a small
explicit allowlist of task/model/effort paths.

For a recognized input object:

1. Extract the observed subtask string. If the path is missing, non-string, or
   longer than 2,000 characters, return no Hook output and let the spawn run.
2. If the input already contains a non-empty explicit model or effort field,
   return no Hook output. Explicit user/agent settings win as a pair; neither
   field is overwritten or completed by Turnhelm.
3. Classify the subtask. `direct` returns no Hook output. An allowlisted profile
   produces a deep copy of the original input with **only** the observed model
   and effort fields added.
4. Return `permissionDecision: "allow"` with `updatedInput` containing the
   original arguments plus those two validated fields. All other fields remain
   byte-for-byte equivalent after JSON serialization.

The adapter does not change `agent_type`, task text, number of spawn calls,
parallelism, `fork_turns`, sandbox, approval, or custom-agent selection. A
custom agent file may still override the effective model/effort; this is a
Codex precedence rule, not a reason to fight the configuration. The TUI trial
must inspect effective child settings rather than trusting the Hook patch.

### Failure behavior

Phase B is fail-open by design. For classifier timeout, transport error,
malformed response, unknown profile, missing schema path, unsupported Hook
rewrite, untrusted/missing Hook, or any command error, emit no blocking
decision and let Codex execute its original spawn request. Do not use the
Phase A fallback profile in Phase B: doing so would silently change existing
orchestration when the classifier is unavailable. Never retry with another
model.

The Hook adds at most the configured classifier latency (four-second request
timeout, five-second Hook timeout) to a spawn that already exists. It does not
run for main-thread turns that do not spawn. Hosted Jev receives subtask text
only when selected; a keyless loopback Laya service is preferred for the TUI
trial because classifier keys in the TUI environment may be visible to
Codex-launched tools.

## Validation and rollout gates

1. **Static/unit gate:** test config validation, System One response parsing,
   Phase A argv construction, spawn-input extraction, explicit-setting bypass,
   exact-input preservation, profile patching, and fail-open behavior. These
   tests may inject route decisions into pure functions; they must not pretend
   to be Jev/Laya integration tests.
2. **Live backend gate:** call a real local `laya[serve]` endpoint and the real
   Jev endpoint with synthetic Chinese and English prompts. Use at least 24
   calls per backend, record p50/p95 latency, and fail the live command on
   unexpected labelled choices. If Laya, Jev, credentials, or model access is
   unavailable, report blocked; never substitute fixtures. Obtain user approval
   before paid calls or checkpoint downloads.
3. **Schema gate:** in a trusted test repository, run a temporary diagnostic
   Hook during one real Codex spawn. Record only Codex version, `tool_name`, and
   recursive key/type names—never values. Pin the observed task/model/effort
   paths in the adapter; if no stable paths exist, mark Phase B unsupported and
   keep Phase A.
4. **Native orchestration gate:** compare no-Hook baseline and Hook runs for
   (a) no delegation, (b) one delegated agent, (c) explicit two-agent parallel
   delegation, (d) explicit model/effort, (e) custom agent role, and (f)
   classifier unavailable. Verify unchanged child count, roles, task messages,
   parallelism, and parent behavior. Verify only unspecified spawns receive a
   model/effort patch, and inspect the child's effective settings.
5. **Promotion gate:** record latency, token usage, routing misses, and any
   topology difference. Only after an explicit go decision may the user merge a
   `turnhelm-hook` PreToolUse entry into their existing user Hook file. Do not
   remove Phase A during this gate; it remains the diagnostic and one-shot path.
   Remove the project-local trial Hook before enabling the user-level copy.
6. **Optional Phase A retirement gate:** retire only the `turnhelm codex`
   execution wrapper after B has passed the primary and second-repository
   topology tests, no repository/CI usage remains, and the user explicitly
   accepts losing root-task routing. Keep the shared classifier, Jev/Laya
   client, `turnhelm route` diagnostics, and `turnhelm-hook`. This is a
   separate refactor, not a success side effect.

## Out of scope

No forced delegation, one-subagent mandate, UserPromptSubmit routing, automatic
fallback in Phase B, automatic Phase A removal, Codex auth/config migration,
proxy integration, App Server client, custom TUI, plugin packaging, model
catalog scraping, transcript parsing, PTY interception, parallel-agent
orchestration, or silent model fallback.

## Source notes

- [Codex Hooks](https://learn.chatgpt.com/docs/hooks): `PreToolUse`, the
  `Agent`/`spawn_agent` tool path, `updatedInput`, Hook trust, and limitations.
- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents):
  orchestration triggers, model/effort precedence, custom agents, and runtime
  overrides.
- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode):
  Phase A `codex exec` behavior and one-run controls.
- [TypeSafe API documentation](https://api.typesafe.ai/docs): real Jev
  `/v1/systemone` contract.
- [Laya package](https://pypi.org/project/laya/): real `laya[serve]` runtime,
  loopback binding, and Jev-compatible endpoint.
