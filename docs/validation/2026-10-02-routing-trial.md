# Turnhelm routing validation status

Date: 2026-10-02

## Completed

- Task 1 configuration and Task 2 classifier implementation are committed.
- Task 3 Phase A CLI is committed.
- Unit suite: 10 tests passing.
- `npm audit --audit-level=high`: no known high-severity findings.
- Real Laya 0.3.22 `typed-decisions` service: 24/24 labelled calls passed;
  p50 34.0ms, p95 56.4ms.
- Real Jev calls: 24/24 labelled calls passed; p50 433.7ms, p95 540.2ms.
- Two read-only Phase A smoke calls completed without repository edits.

## Phase B schema gate: blocked

Environment:

- Codex CLI: 0.160.0
- Probe model: `gpt-6.1-sol` (the currently available Codex model)
- Hook event requested: `PreToolUse`, matcher `^Agent$`
- Probe Hook: temporary, local-only, removed after the test

The real native orchestration created a hosted `collab_tool_call` item and
returned a child result, but no `PreToolUse` event with `tool_name: "Agent"`
arrived. The temporary shape file was not produced. An earlier ephemeral probe
also failed before child execution because the thread store had no rollout; the
non-ephemeral probe with the current model confirmed the hosted collaboration
path. A temporary trust-bypass invocation was used only to distinguish Hook
trust from tool-path coverage; no Hook was installed or left trusted.

Because the current runtime does not expose the spawn through the Hook path,
Turnhelm must not guess the `spawn_agent` argument schema or implement
`updatedInput` rewriting. Phase B remains unsupported for this Codex runtime;
Phase A is the supported implementation.

No raw prompts, tool arguments, credentials, or model outputs are stored here.

## Phase A auto-mode note (2026-10-03)

Phase A auto mode is the supported local-first path: it tries Laya first and
uses hosted Jev only when `hostedJev.enabled` is true and
`TURNHELM_ALLOW_HOSTED_JEV=1`. Native subagent Hook/Gateway routing remains
unsupported.
