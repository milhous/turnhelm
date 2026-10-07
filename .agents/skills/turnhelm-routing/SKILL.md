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
   Codex child do not see your session context. Pass the task as a single
   quoted positional or pipe it on stdin. Automatic selection picks an
   ordinary profile for normal work and `frontier_max` when the task genuinely
   needs maximum effort. No max-specific flag, disable setting, or extra
   classification stage exists; never work around that.

2. Treat routing as selection only. Runs are read-only by default; workspace
   writes require explicit `--write` given immediately before the run, and
   hosted backends require separate, explicit authorization given immediately
   before the consequential operation. Never put `--write`, hosted-Jev opt-ins,
   credentials, or config edits into a reusable default command. After a write
   run, inspect the diff and run focused tests; preserve unrelated user
   changes.

3. Respect the managed-child rule: Turnhelm marks the Codex children it
   launches with `TURNHELM_MANAGED_CHILD=1`; never invoke `turnhelm run`
   recursively from inside such a session. From Claude Code, this launches a
   separate Codex process; use Claude's native tools when no separate Codex
   child is needed.

## Profiles and routing contract

- The six fixed profiles are `fast`, `balanced`, `deep`, `frontier`,
  `frontier_xhigh`, and `frontier_max`. Ordinary automatic selection picks one
  of them for every run, including `frontier_max` when the task genuinely
  needs maximum effort; there is no max gate, override flag, or extra
  classification stage.
- A task is bounded at 8192 UTF-8 bytes. Longer input is refused with an
  error, never truncated or silently shortened; keep the full self-contained
  requirement within that bound.
- The project config lives at `.turnhelm/config.json` (version 1) with
  `routingTimeoutMs`, `backends.laya`, `backends.jev`, and the six profiles.
  Edit only to that shape; unknown keys are rejected.
- A classifier or model-access failure does not trigger an unapproved model
  retry. Stop rather than guessing.

## Backend and data boundaries

- Local Laya is tried first (`backends.laya.enabled`); hosted Jev is attempted
  only when both `backends.jev.enabled: true` is set in `.turnhelm/config.json`
  and `TURNHELM_ALLOW_HOSTED_JEV=1` is present in the environment. Never
  enable either setting automatically.
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
| Retrying with a different model after failure | Stop; do not guess or hand-pick a model. |
| Invoking `turnhelm run` from a managed child | Parent sessions only. |
| Sending a partial task description | One self-contained prompt carries the full requirement. |
