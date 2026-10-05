---
name: turnhelm-routing
description: Use when a Codex CLI or Claude Code agent needs to inspect or execute a task through Turnhelm's model/effort routing, Laya/hosted Jev policy, or Codex read-only/workspace-write boundary.
---

# Turnhelm Routing

Turnhelm is an explicit parent-agent boundary. It selects one validated
model/effort pair for a separate Codex child run; it does not change the model,
effort, permissions, or native subagents of the current Codex or Claude Code
session.

## Safe execution flow

1. Inspect before executing:

   ```bash
   turnhelm route "<task>"
   ```

   Review the JSON `source`, `profileId`, `profile.model`, and
   `profile.effort`. This starts no Codex child, but classification may call the
   configured Laya or hosted Jev backend.

2. Prefer read-only execution:

   ```bash
   turnhelm codex "<task>"
   ```

   This launches `codex exec --sandbox read-only` and forwards the task on
   stdin.

3. Use workspace writes only after the user explicitly authorizes the exact
   change:

   ```bash
   turnhelm codex --write "<task>"
   ```

   `--write` is not implied by “continue”, a route result, or a general
   request to help. After a write run, inspect the diff and run focused tests;
   preserve unrelated user changes.

If the checkout is not installed as a `turnhelm` binary, build first with
`pnpm run build` and use `node dist/src/cli.js ...` for the same commands.

## Routing contract

- In auto profile mode, the stable roles are `fast` → `gpt-6-luna/low`,
  `balanced` → `gpt-6.1-sol/medium`, `deep` → `gpt-6.1-sol/high`, and
  `frontier` → `gpt-6-astra/xhigh`.
- A role is emitted only when its official model/effort pair is supported by
  read-only local Codex capability signals: a listed/API-backed cache entry or
  the active official default model. Unknown or hidden entries are ignored;
  unavailable roles are omitted and auto mode fails closed if none remain.
- Capability discovery performs no runtime network request, paid probe, Codex
  subprocess, persistent snapshot, or config mutation. A `direct` decision
  intentionally passes no model or reasoning-effort override to Codex.
- Continuation-only prompts and prompts longer than 2000 JavaScript UTF-16
  code units use the configured fallback profile; they are not sent to the
  classifier.

## Backend and data boundaries

- `backend: auto` tries local Laya first and may try hosted Jev only when both
  `hostedJev.enabled: true` and `TURNHELM_ALLOW_HOSTED_JEV=1` are present.
  Never enable either setting automatically.
- Hosted Jev requires `TYPESAFE_API_KEY`; local Laya may require
  `LAYA_API_KEY`. Keep keys out of tasks, logs, diffs, and committed config.
  Turnhelm strips these keys and `TURNHELM_CONFIG` from the Codex child
  environment.
- The full task text is sent to the configured classifier before a profile is
  selected. Remove secrets or sensitive data before routing and consider data
  residency, cost, and consent before enabling a hosted backend.
- A classifier or model-access failure does not trigger an unapproved model
  retry. Without a configured fallback, stop rather than guessing.

## Runtime boundaries

- From Claude Code, this launches a separate Codex process; it does not switch
  Claude's current model or permission mode. Use Claude's native tools when no
  separate Codex child is needed.
- From Codex, invoke the launcher from the parent session only. Do not invoke
  `turnhelm codex` recursively from a Turnhelm-managed Codex child.
- Do not put `--write`, hosted-Jev opt-ins, credentials, or config edits into a
  reusable default command. Ask for explicit authorization immediately before
  the consequential operation.

## Common mistakes

| Mistake | Correct behavior |
| --- | --- |
| Treating `route` output as permission to edit | Treat it as a selection; authorization is separate. |
| Assuming `route` is fully offline | It avoids a Codex child, but its classifier may use configured backends. |
| Enabling Jev when Laya is unavailable | Require the two opt-ins, credentials, and data-egress approval. |
| Expecting a Claude/Codex session model switch | The selected model applies only to the spawned Codex run. |
| Retrying with a different model after failure | Use the configured fallback or stop; do not guess. |
