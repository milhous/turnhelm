# turnhelm

Local-first task routing for Codex. Turnhelm chooses a validated model and
reasoning-effort profile; Codex keeps its own authentication and provider.

Copy `examples/config.json` to `~/.config/turnhelm/config.json` and set model
names your Codex account can use. Set `backend` to `auto` for loopback-first
routing: Laya runs locally before any hosted option. Hosted Jev is used only
when `hostedJev.enabled` is true and `TURNHELM_ALLOW_HOSTED_JEV=1`. Phase A
chooses one configured model/effort profile before Codex starts. Native
subagent routing and the old Hook/Gateway experiments are unsupported.

## Phase A

Run `turnhelm route "task"` to inspect the selected profile without starting
Codex. Run `turnhelm codex "task"` for read-only Codex execution, or
`turnhelm codex --write "task"` for workspace-write. A backend failure uses
only the configured `fallbackProfile`; without one, the task stops before
Codex runs. Model-access failures do not trigger another model.
