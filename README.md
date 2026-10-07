# turnhelm

Local-first task entry for Codex. Turnhelm classifies a coding task against
six fixed model/reasoning-effort profiles, then starts a separate Codex
process with an explicit sandbox boundary.

Turnhelm does **not** switch the model or permissions of the current Codex or
Claude Code session. It is a parent-agent launcher: read-only by default,
workspace writes only with an explicit `--write` command. Codex remains
responsible for its own authentication and provider access.

## Commands

| Command | Behavior | Child sandbox |
| --- | --- | --- |
| `turnhelm init [--dry-run]` | Install the managed skill, project config, and AGENTS block | No Codex child |
| `turnhelm doctor [--json] [--probe]` | Report project, toolchain, config, and skill readiness | No Codex child |
| `turnhelm run "<task>"` | Classify once, then execute the task in a Codex child | `read-only` |
| `turnhelm run --write "<task>"` | Execute an explicitly approved change | `workspace-write` |

The task comes from one self-contained positional argument or piped stdin
(bounded at 8192 UTF-8 bytes; never truncated). `doctor --probe` sends exactly
one synthetic classification request to each eligible backend (two when both
gates are eligible); a plain `doctor` never sends a request. A `run` emits
exactly one JSON receipt on stderr once classification starts, describing
routing attempts, the selection, and the worker outcome; local task-input,
configuration, and preflight rejections happen before classification and
emit no receipt.

## Quick start

Requirements: Node.js `>=22.8.0`, pnpm `10.12.1` (pinned in `package.json`),
a local Git work tree, and a Codex CLI 0.160.0 or newer.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build

# In the target project: install .turnhelm/config.json, the shared skill,
# and the managed AGENTS.md block.
turnhelm init

# Inspect readiness without executing anything.
turnhelm doctor
```

The canonical project config template is
[assets/config.json](assets/config.json); `turnhelm init` installs it as
`.turnhelm/config.json`.

## Project configuration

`.turnhelm/config.json` (version 1) is the only configuration surface. There
is no global or home-directory config. Unknown keys are rejected.

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

- `routingTimeoutMs` is the total classification budget, an integer from 100
  to 30000.
- `backends.laya.url` must be an HTTP loopback origin without credentials,
  path, query, or fragment.
- All six profiles are required; each names a model and reasoning effort.

## Six profiles and automatic selection

Classification always selects one of the six profiles; there is no bypass,
no max-effort flag, and no extra classification stage. `frontier_max` is an
ordinary selection outcome reached when the task genuinely needs maximum
effort.

| Profile | Model | Effort |
| --- | --- | --- |
| `fast` | `gpt-6-luna` | `low` |
| `balanced` | `gpt-6.1-sol` | `medium` |
| `deep` | `gpt-6.1-sol` | `high` |
| `frontier` | `gpt-6-astra` | `high` |
| `frontier_xhigh` | `gpt-6-astra` | `xhigh` |
| `frontier_max` | `gpt-6-astra` | `max` |

Selection is judged by uncertainty, coupled constraints, required
verification, and the consequences of an incorrect result — never by prompt
length or keywords.

## Classification request and response

The task text is sent to the configured backend at `POST /v1/systemone`:

```json
{
  "state": "<task>",
  "model": "typed-decisions",
  "questions": {
    "route": {
      "type": "choice",
      "instructions": "Choose the lightest profile that meets the task's requirements, judged by uncertainty, coupled constraints, required verification, and the consequences of an incorrect result; never by prompt length, file count, or keywords such as security, architecture, or deep analysis.",
      "criteria": { "fast": "...", "balanced": "...", "deep": "...", "frontier": "...", "frontier_xhigh": "...", "frontier_max": "..." }
    }
  }
}
```

Hosted Jev uses the same envelope with `model: "jev-latest"`. The only
accepted response shape is the nested choice answer:

```json
{ "answers": { "route": { "type": "choice", "choice": "<profileId>" } } }
```

`choice` must be one of the six own profile IDs; anything else fails the run.

## Backend failover

Local Laya is tried first when `backends.laya.enabled` is true. When **both**
backends are eligible, Laya receives `min(1000, floor(routingTimeoutMs / 4))`
of the routing budget so a hosted attempt can still run; a sole eligible
backend receives the total remaining budget. Hosted Jev is attempted only
when **all** of the following hold: `backends.jev.enabled` is true in the
project config, `TURNHELM_ALLOW_HOSTED_JEV=1` is present in the environment,
and `TYPESAFE_API_KEY` is set. Both settings are deliberate, explicit
opt-ins; Turnhelm never enables them automatically.

A classification failure never triggers an unapproved model retry; the run
fails with its recorded attempts. Local Laya may require `LAYA_API_KEY`.

## Safety boundaries

- **Read-only by default.** The Codex child receives `--sandbox read-only`
  unless `--write` was given explicitly on the same `run` invocation.
- **No recursion.** Turnhelm marks its Codex children with
  `TURNHELM_MANAGED_CHILD=1`; `run` inside such a session is refused.
- **Secrets are stripped from the child.** `LAYA_API_KEY`,
  `TYPESAFE_API_KEY`, `TURNHELM_ALLOW_HOSTED_JEV`, and `TURNHELM_CONFIG`
  never reach the Codex child environment. Keep keys out of tasks, logs,
  diffs, and committed config.
- **Bounded child output.** Raw worker stderr and arbitrary error text never
  cross the diagnostic boundary; the parent prints fixed-category lines and
  the structured receipt only.
- Remove secrets and sensitive data from a task before routing; the full
  task text is sent to the configured classifier.

## Usage evidence is honest, not authoritative

- When the Codex child reports no usage snapshot, the receipt says
  `usage: "unreported"` — never zero and never omitted.
- Whole-run usage scope is `"unverified"`: client-side usage aggregation is
  not confirmed, so receipts report snapshots, not a total task cost or a
  saving percentage.
- Codex client config-key semantics (for example `agents.enabled`) are
  **unverified** from `--help` evidence alone; doctor reports this
  explicitly instead of claiming a pass.

## Agent skills (Codex CLI + Claude Code)

The canonical shared skill is
`.agents/skills/turnhelm-routing/SKILL.md`; `turnhelm init` installs it into
the project. Codex CLI and Claude Code both read the same instructions:
one self-contained prompt, read-only default, explicit `--write`, automatic
`frontier_max` selection, and no unapproved model retry after failure.

## Development and verification

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build

# Hermetic tests: do not use classifier credentials or hosted Jev.
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV pnpm test
env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV pnpm run test:coverage

# Dependency audit.
pnpm audit --audit-level high
```

Compatibility evidence: Codex CLI 0.160.0 (official native binary:
`--version` exit 0, `exec --help` advertising `--json`, `--ephemeral`,
`--sandbox`, and stdin) and local 0.160.1. Functional delivery does not
authorize a benefit trial; any comparison against a fixed baseline requires
separate owner approval. Historical Phase A receipts are recorded in
[`docs/validation/2026-10-03-jev-laya-phase-a.md`](docs/validation/2026-10-03-jev-laya-phase-a.md).
