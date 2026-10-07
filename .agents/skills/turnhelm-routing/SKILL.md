---
name: turnhelm-routing
description: Use when a Codex CLI or Claude Code agent needs to inspect or execute a task through Turnhelm's model/effort routing, Laya/hosted Jev policy, or Codex read-only/workspace-write boundary.
---

<!-- turnhelm-template v1 -->

# Turnhelm Routing

Turnhelm is an explicit parent-agent boundary. The `turnhelm run` entry selects
one validated model/effort pair and launches a separate Codex child; it does
not change the model, effort, permissions, or native subagents of the current
Codex or Claude Code session.

## Safe execution flow

1. Send the whole task in one self-contained prompt:

   ```bash
   turnhelm run "<task>"
   ```

   State the full task requirement in the prompt itself; the router and the
   Codex child do not see your session context. Automatic selection picks an
   ordinary profile for normal work and `frontier_max` when the task genuinely
   needs maximum effort. No max-specific flag, disable setting, or extra
   classification stage exists; never work around that.

2. Treat routing as selection only. Workspace writes and hosted backends each
   require separate, explicit authorization given immediately before the
   consequential operation. Never put `--write`, hosted-Jev opt-ins,
   credentials, or config edits into a reusable default command. After a write
   run, inspect the diff and run focused tests; preserve unrelated user
   changes.

3. Respect the managed-child rule: never invoke `turnhelm run` recursively from
   inside a Turnhelm-managed Codex child. From Claude Code, this launches a
   separate Codex process; use Claude's native tools when no separate Codex
   child is needed.

## Profiles and routing contract

- The six fixed profiles are `fast`, `balanced`, `deep`, `frontier`,
  `frontier_xhigh`, and `frontier_max`. Automatic mode selects one of them; a
  `direct` decision passes no model or reasoning-effort override to Codex.
- Continuation-only prompts and prompts longer than 2000 JavaScript UTF-16
  code units use the configured fallback profile; they are not sent to the
  classifier.
- A classifier or model-access failure does not trigger an unapproved model
  retry. Without a configured fallback, stop rather than guessing.

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

## Common mistakes

| Mistake | Correct behavior |
| --- | --- |
| Treating routing output as permission to edit | Authorization is separate and explicit. |
| Assuming routing is fully offline | The classifier may use configured backends. |
| Looking for a max-effort flag | Automatic selection already includes `frontier_max`. |
| Expecting a Claude/Codex session model switch | The selected model applies only to the spawned Codex run. |
| Retrying with a different model after failure | Use the configured fallback or stop; do not guess. |
| Invoking `turnhelm run` from a managed child | Parent sessions only. |
| Sending a partial task description | One self-contained prompt carries the full requirement. |
