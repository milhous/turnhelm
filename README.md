# turnhelm

Local-first task routing for Codex. Turnhelm chooses a validated model and
reasoning-effort profile; Codex keeps its own authentication and provider.

Copy `examples/config.json` to `~/.config/turnhelm/config.json`. Set
`profileMode` to `auto` (the shipped example does) to materialize only the
stable roles available to the local Codex installation. Set `backend` to
`auto` for loopback-first routing: Laya runs locally before any hosted option.
Hosted Jev is used only when `hostedJev.enabled` is true and
`TURNHELM_ALLOW_HOSTED_JEV=1`. Phase A chooses one model/effort profile before
Codex starts. Native
subagent routing and the old Hook/Gateway experiments are unsupported.

Auto capability profiles are generated in memory from this fixed policy:

| role | model / effort |
| --- | --- |
| `fast` | `gpt-6-luna` / `low` |
| `balanced` | `gpt-6.1-sol` / `medium` |
| `deep` | `gpt-6.1-sol` / `high` |
| `frontier` | `gpt-6-astra` / `xhigh` |

The official effort matrix is `low`, `medium`, `high`, `xhigh`, `max` for
`gpt-6-astra` and `gpt-6.1-sol`; `gpt-6-luna` additionally supports `none`.
Roles are emitted only when the model is in that matrix and is supported by a
visible (`list` in Codex cache metadata), API-backed entry in the read-only
`$CODEX_HOME/models_cache.json` or is the official model in
`$CODEX_HOME/config.toml`. Hidden (`hide`) or unknown metadata is ignored;
malformed metadata is ignored safely. `balanced`, then `fast`, is selected as the
automatic fallback; if no role is available, config loading fails closed
instead of routing to an unqualified model. Explicit mode remains available
for controlled deployments and test fixtures, including safe provider-specific
model IDs such as the legacy `gpt-6-sol`; that legacy ID is not part of the
auto policy.

Capability resolution performs no runtime network request, Codex subprocess or
paid probe, persistent snapshot, daemon, or user-config mutation. The cache and
default-model signals are bounded, read-only hints. `direct` remains unchanged:
it emits no `--model` or reasoning-effort override, and a selected profile is
bound to one immutable pair for that Codex run.

## Phase A

Run `turnhelm route "task"` to inspect the selected profile without starting
Codex. Run `turnhelm codex "task"` for read-only Codex execution, or
`turnhelm codex --write "task"` for workspace-write. A backend failure uses
only the configured `fallbackProfile`; without one, the task stops before
Codex runs. Model-access failures do not trigger another model.

Continuation-only tasks and tasks longer than 2000 JavaScript UTF-16 code
units stay local and require `fallbackProfile`. The direct classifier helpers
(`classifyTask` and `chooseProfile`) reject those inputs, as well as invalid or
blank tasks, before network work. Eligible classifier text is not truncated;
the request builder is private and HTTP redirects are rejected.
Classifier responses are streamed with a 65536-byte UTF-8 limit, independent
of Content-Length; invalid encoding/JSON and oversized bodies fail generically.
Non-success HTTP bodies are cancelled without reading; errors reveal only status.
Only `direct` or an own configured profile ID is accepted.
Joined CLI task text, including leading/trailing whitespace and newlines, is
preserved for classification and Codex stdin; only blank-input validation trims.
Codex completion waits for child/stdio closure: stdin failures cannot report
success, nonzero child statuses are preserved, and spawn failures are controlled.

## Development

Use Node.js >=22.8.0 (CI uses Node 24). Offline tests use dummy credentials,
loopback fixtures, and a temporary Codex executable, never real Codex or hosted
services:

```bash
npm ci --ignore-scripts
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV npm test
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV npm run test:coverage
npm audit --audit-level=high
```

The 2026-10-03 final boundary verification passed 192/192 tests on exact Node
22.8.0 (bundled npm 10.8.2), Node 24.21.0, and Node 26.5.0; source coverage was
99.26% lines, 93.79% branches, and 100% functions on each target. No new live
calls were made; see [dated validation](docs/validation/2026-10-03-jev-laya-phase-a.md).

Coverage includes every production module in `dist/src/**`, including CLI
children, and enforces at least 80% lines, branches, and functions. The pinned
offline CI workflow retains coverage and dependency-audit gates. The separate
`test:live` command requires explicit approval, real services, and credentials;
it is not part of offline verification.
