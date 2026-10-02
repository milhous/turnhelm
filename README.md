# turnhelm

Local-first task routing for Codex. Turnhelm chooses a validated model and
reasoning-effort profile; Codex keeps its own authentication and provider.

Copy `examples/config.json` to `~/.config/turnhelm/config.json` and set model
names your Codex account can use. Set `backend` to `laya` for a real local
loopback `laya[serve]` process using the `typed-decisions` checkpoint, or `jev`
for the hosted TypeSafe service with `TYPESAFE_API_KEY` in the environment.
Hosted Jev receives the submitted task text. Turnhelm does not log it or store
the key.

## Phase A

Run `turnhelm route "task"` to inspect the selected profile without starting
Codex. Run `turnhelm codex "task"` for read-only Codex execution, or
`turnhelm codex --write "task"` for workspace-write. A backend failure uses
only the configured `fallbackProfile`; without one, the task stops before
Codex runs. Model-access failures do not trigger another model.

## Phase B pilot

Phase B is opt-in. A reviewed `PreToolUse` Hook runs only when native Codex has
already decided to spawn an agent. It may add an allowlisted model and effort
to an otherwise unspecified spawn. It does not create agents, change parallel
orchestration, alter explicit settings, or affect tasks with no spawn. Backend
and Hook failures pass through the original spawn unchanged.

Do not install the Hook globally until the real TUI baseline and Hook comparison
passes in the validation plan. Never add a `UserPromptSubmit` Hook for
delegation.
