# Turnhelm routing design

Date: 2026-09-30

## Decision

Build a local-first TypeScript CLI on Node.js 22+ in two phases. Phase A routes
one task before starting `codex exec`. Phase B keeps the native Codex TUI and
uses a `UserPromptSubmit` hook to recommend delegation to one subagent with an
explicit model and reasoning effort. Phase B is **delegated task execution**,
not a change to the main TUI thread's model. The user accepts the extra
subagent latency and token use. Non-coding messages stay with the main thread.

Do not modify Codex CLI/TUI source, add a Codex API, manage Codex credentials,
write `~/.codex/config.toml`, or configure an inference proxy. Both phases
inherit the user's existing Codex provider, authentication, policies, and other
configuration. Backward compatibility is not a design goal.

## Scope and boundaries

- Routing input is the submitted task text. Do not read the repository or a
  session transcript merely to classify a task. Do not log raw prompts or keys.
- A route is either `direct` or one profile ID from a small user-configured
  allowlist. Each profile maps to one fixed `model` and `effort` pair. Model names
  in classifier output are never executed directly. Use one JSON file at
  `$HOME/.config/turnhelm/config.json` (or `TURNHELM_CONFIG` for a test file),
  with keys `backend` (`laya` or `jev`), `layaUrl`, `profiles`, and optional
  `fallbackProfile`. Each of at most four profiles has a short description
  (at most 80 characters), `model`, and `effort`. Jev uses the official endpoint,
  the `jev-latest` alias, and `TYPESAFE_API_KEY`; Turnhelm does not store that
  key. A local Laya service may optionally require `LAYA_API_KEY` from the
  environment.
- Treat prompt text and backend output as untrusted. The hook's developer
  context is a fixed template containing only validated profile values; it
  never echoes the prompt or arbitrary backend text into that context.
- Jev and Laya are selectable decision backends behind the same narrow
  `classifyTask` function. Use their real `/v1/systemone` endpoints; normalize
  only the fields needed to resolve a choice. Do not treat backend confidence
  numbers as interchangeable or add an uncalibrated confidence threshold.
- `direct` is for status, clarification, and other non-coding conversation.
  Coding, debugging, and review tasks are candidates for one subagent. No
  parallel subagents or nested routing in the initial design.
- A short, context-dependent continuation such as `继续` or `continue` cannot
  be reliably classified from its text alone. Route a small set of explicit
  continuation phrases to the configured fallback profile before calling a
  decision backend. If no fallback is configured, block the prompt with an
  actionable error instead of guessing from unavailable conversation history.
  Do not add transcript parsing or per-session route storage.
- A prompt longer than 2,000 characters also uses the configured fallback
  profile before any backend call, because silently truncating it for Laya
  would make the route untrustworthy. Without a fallback, block rather than
  silently classifying only a prefix.
- The main thread continues to use its own model. Turnhelm does not claim that
  the native TUI's active model changes.

## Phase A: single-task CLI

`turnhelm codex "<task>"` loads the route configuration, calls the selected
real decision backend, validates the selected profile, then starts `codex exec`
with a one-run model flag and reasoning-effort override. It passes the original
task text as data, not as shell syntax. It does not use `--ignore-user-config`,
since the user chose to retain their current Codex configuration. Codex owns
login, sessions, tool permissions, and model-access errors. Phase A defaults to
Codex's read-only execution; an explicit `--write` option requests
`workspace-write`. It never selects unrestricted access on the user's behalf.
It strips classifier-only keys (`TYPESAFE_API_KEY` and `LAYA_API_KEY`) from the
environment of the spawned Codex process without changing Codex auth keys.

Phase A proves the classifier, profile mapping, command construction, and
end-to-end latency. It is not a second permanent execution system. After Phase B
is verified, retire the Phase A automatic execution entrypoint and retain a
read-only route-diagnostic command so the same task cannot be routed twice.

## Phase B: native TUI hook and delegation

The first trial installs the hook only in a trusted test repository. The user
reviews and trusts it through Codex's `/hooks` UI. After real-TUI acceptance,
the user may separately opt into a user-level hook for other repositories.
Turnhelm does not silently install or trust a global hook. The pilot uses this
repository as its test repository, rather than changing another project. A
separate installed `turnhelm-hook` command from a tested package snapshot is
the user-level entrypoint; it does not resolve the hook script from the
current repository. Before enabling the user-level hook, remove the
project-local trial hook to prevent duplicate classification. Preserve
existing user hooks, and do not add a second Turnhelm or conflicting router
handler. Retire Phase A only after a real TUI trial in a second repository
confirms the user-level hook works.

For each submitted natural-language prompt, the synchronous
`UserPromptSubmit` hook calls the same `classifyTask` logic. For `direct`, it
returns no extra instructions. For a coding route, it returns brief developer
context containing the selected profile's model and effort, asking the main
thread to spawn exactly one subagent, forward the user's task and relevant
conversation context, wait for completion, and report the result. The main
thread must not perform the coding work itself when delegation succeeds. The
TUI trial must inspect the child agent's effective model and effort: a custom
agent file can override explicit spawn settings, so argument inspection alone
does not prove the route actually used.

This is an instruction to the main agent, not a guaranteed model switch or a
guaranteed tool invocation. The initial implementation does not add
`PreToolUse` rewriting, `Stop`-hook retries, static agents for every profile,
PTY interception, an App Server adapter, or a Turnhelm daemon. If the main
agent routinely fails to delegate, report that Phase B does not meet its goal
instead of stacking hooks to hide the failure. Verify during the TUI trial
whether the hook fires for subagent prompts. If it does and no documented
root-only discriminator is available, do not enable Phase B; do not use
transcript parsing or prompt sentinels as a recursion guard.

## Failure behavior

- Backend timeout, transport error, malformed response, or unknown profile:
  use only an explicitly configured fallback profile. Without one, Phase A
  exits before starting Codex; the Phase B hook returns a blocking explanation
  for that prompt.
- A model/effort rejected by Codex or an inaccessible model is surfaced as an
  error. Never retry on another model silently.
- A hook that is missing, disabled, untrusted, or crashes may not block a Codex
  turn. Verify activation using Codex's `/hooks` UI and a real prompt in the
  test repository; do not claim a separate machine-checkable trust guarantee.
  Phase B is best-effort delegation, not an enforcement boundary. An expected
  classifier error is caught and converted into an explicit block, but that
  does not solve hook non-execution.
- The hook has a five-second hard timeout, the backend request has a four-second
  timeout, and the hook emits only compact route context. It never loads a Laya
  checkpoint for every prompt; a real local Laya service must already be
  available on `127.0.0.1` or `::1`. Never expose an unauthenticated Laya
  listener on `0.0.0.0`. Hosted Jev receives task text only when the user
  selects that backend. If native TUI is launched with classifier keys such as
  `TYPESAFE_API_KEY` or `LAYA_API_KEY`, those keys may also be visible to
  Codex-launched tools; do not claim key isolation. Prefer keyless loopback
  Laya for the Phase B trial while still testing the real Jev path in Phase A.

## Validation and performance gate

Do not fake Jev or Laya. Deterministic parsing, profile validation, and CLI
argument construction may have pure unit tests, but backend integration tests
must call a real local Laya endpoint and a real Jev endpoint from the local
test runner. Use synthetic, non-sensitive prompts and environment-supplied
credentials. If either backend is unavailable, report its live test as blocked,
never as passed by a mock or canned response. Phase A is not complete until
both real integrations pass. Real calls are confined to an explicit live-test
command rather than the fast default test suite. The Laya test uses the
upstream `laya[serve]` runtime on loopback; Turnhelm does not install or start
it automatically. The Jev test calls the real hosted service from the local
test process.

1. Phase A live tests exercise both backends against the same small,
   pre-labelled set of synthetic Chinese and English coding and non-coding
   prompts. Check expected route as well as response shape, allowed values,
   error behavior, and latency. A read-only real `codex exec` smoke test checks
   that each configured model/effort pair is accepted without changing auth.
2. Phase B starts in a trusted test repository. Real native-TUI trials cover a
   coding prompt, a non-coding prompt, and an explicit short continuation.
   Inspect the actual subagent model/effort, verify one delegation for coding
   tasks, no delegation for non-coding tasks, and no recursive hook loop.
3. Use at least 20 real calls per backend to record median and 95th-percentile
   classification latency. For the more costly native-TUI trials, record each
   scenario's time from prompt submission to subagent start, end-to-end task
   time, and token use against a native-TUI baseline. Publish the measured
   overhead and routing misses rather than assuming a gain.
4. Present the live results, including routing misses and overhead, for an
   explicit user go/no-go decision before promoting the hook from project-local
   to user-level. Do not claim deterministic per-turn routing from a passing
   unit suite or a small smoke test.

## Out of scope

No Codex auth or config migration, proxy integration, App Server client,
custom TUI, plugin packaging, automatic global Hook installation, model
catalog scraping, parallel-agent orchestration, or silent model fallback.

## Source notes

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
  documents one-run CLI execution and flags.
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks) documents
  `UserPromptSubmit`, hook trust, blocking outputs, timeouts, and tool-hook
  limitations.
- [Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
  documents explicit subagent model/effort settings and their additional cost.
- [TypeSafe API documentation](https://api.typesafe.ai/docs) documents the
  real Jev `/v1/systemone` endpoint.
- [Laya's published package](https://pypi.org/project/laya/) documents the
  real `laya[serve]` runtime, loopback binding option, and Jev-compatible
  endpoint.
