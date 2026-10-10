---
name: turnhelm-routing
description: Use when an agent needs to prepare or inspect a Turnhelm project, execute an authorized task in a separate model/effort-routed Codex child, or review Turnhelm route decision evidence.
---

<!-- turnhelm-template v1 -->

# Turnhelm Routing

Turnhelm selects a model/effort pair and launches a separate Codex child. It
does not switch the current Codex/Claude Code session or its native subagents.
Use native tools when no separate Codex child is needed.

## Prepare and inspect a project

Commands use the current directory, or the exact directory passed with
`--project <dir>`; they never discover a parent config, even inside a Git
work tree. Requirements: Node >=24.0.0 (22.8 support dropped; validation on
an actual 24.x >=24.5.0), Codex CLI >=0.160.0; `run` needs Git.

| Command | Effect |
| --- | --- |
| `turnhelm init --dry-run [--project <dir>]` | Inspect installation; write nothing. |
| `turnhelm init [--project <dir>]` | Install config, shared skill/metadata, and managed AGENTS block. |
| `turnhelm doctor [--json] [--project <dir>]` | Offline checks; no classification or worker. |
| `turnhelm doctor --probe [--project <dir>]` | One synthetic request per eligible backend; no worker. |

The sole config is `.turnhelm/config.json` (v1): `routingTimeoutMs`,
`backends.laya`, `backends.jev`, and six `profiles`; unknown keys are rejected.
`init` preserves valid config and unrelated AGENTS text; repeated identical
installation is a no-op. Conflicting or changed skill files are refused,
not overwritten. Stop for owner reconciliation, not automatic deletion.
Restart existing Codex sessions after installation. Missing config is a
doctor failure; offline eligibility is not reachability or model access.
Obtain request/data authorization before `--probe`; it is not an offline check.

## Existing local Laya

If Laya 0.3.22 serve dependencies and `typed-decisions` weights are already
installed/cached, use its venv Python, not a possibly stale console shebang:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
LAYA_HOST=127.0.0.1 LAYA_PORT=8765 \
LAYA_MODELS=typed-decisions LAYA_PRELOAD=1 \
LAYA_DEVICE=cpu LAYA_THREADS=4 \
"/absolute/path/to/laya-venv/bin/python" -I -B -u -m laya.serve
```

Keep the thread cap within physical cores. Reuse a healthy existing service;
otherwise check `http://127.0.0.1:8765/health` from another terminal for
`status: "ok"`, loaded `typed-decisions`, and actual device. This health check
does not classify. Missing dependencies/cache require separate install/download
approval. Offline flags constrain model loading, not all network activity;
foreground startup does not enable autostart or change privacy permissions.

## Execute an authorized task

```bash
turnhelm run --project "/path/to/project" -- "<full self-contained task>"
```

Pass one quoted task or pipe stdin; `--` protects an option-like task. The
classifier and child cannot see session context. Input is limited to
8192 UTF-8 bytes; invalid/oversized input is rejected, never shortened.

- Default sandbox is `read-only`. Add `--write` only after explicit approval
  immediately before that run. Routing is not write authorization; `--write`
  does not override host-protected paths or approval policy. Review the
  resulting diff/tests and preserve unrelated changes.
- Successful classification selects among `fast`, `balanced`, `deep`, `frontier`,
  `frontier_xhigh`, `frontier_max`. Maximum effort is an ordinary automatic
  selection; no bypass, max flag, or extra stage exists. A run launches at most
  one worker. A failed run means stop, not an unapproved model retry.
- Never run recursively when `TURNHELM_MANAGED_CHILD=1`.

## Backend and data boundaries

Laya is tried first when `backends.laya.enabled` is true. Hosted Jev requires **all three**:
`backends.jev.enabled: true`, `TURNHELM_ALLOW_HOSTED_JEV=1`, and a nonblank
`TYPESAFE_API_KEY`. Obtain explicit hosted authorization immediately before
use. Do not enable gates or edit config without approval; keep write/hosted
opt-ins out of reusable defaults. Laya may require `LAYA_API_KEY`.

The full task goes to the classifier: remove secrets and consider residency,
cost, and consent first. Keep keys out of prompts/logs/diffs/config. The child's
initial environment omits `LAYA_API_KEY`, `TYPESAFE_API_KEY`,
`TURNHELM_ALLOW_HOSTED_JEV`, and legacy `TURNHELM_CONFIG`. This is not filesystem
or shell-startup isolation: a shell can reload host secrets. Do not read key
values or change authentication/shell settings to make a check pass.

## Interpret results

Worker output is on stdout; fixed diagnostics and one `turnhelm.receipt` JSON
are on stderr **once classification starts**. Input/config/preflight rejection
has no receipt. Read the exit code and routing/worker statuses, not stderr
presence or a selected profile alone.

Every run that reaches classification appends one JSON evidence line to
`.turnhelm/routes.jsonl` in the project root before the worker starts,
whatever the outcome. It records the task's SHA-256 hash and byte length
(never the task text), the routing status, per-backend attempts, and, on
selection, the backend, profile, model, effort, and the classifier's
`confidence` when the backend reports one. Journaling is best-effort: a
missing, unwritable, or non-regular journal path (symlink, FIFO) is diagnosed
and skipped; it never fails or blocks the run. Use it to review routing
decisions after the fact.

To validate routing, submit the complete current requirement once, with
`--write` only for an explicitly approved edit; then review the actual receipt,
worker exit, scoped diff and checks. No forced profile or preliminary worker
is needed. Routing is sequential, with at most one attempt per eligible backend:
Laya success means no Jev run request. When both backends are eligible, Laya
receives about three quarters of the remaining deadline, reserving the
remainder for authorized Jev; a sole backend receives all of it. A
failed/timed-out Laya attempt can still succeed through authorized Jev within
the shared deadline. If routing fails
with `worker.status: "not-started"`, no delegation succeeded; report it rather
than silently changing gates/budget.

Offline `doctor` makes no requests. An authorized `doctor --probe` checks each
eligible classifier separately, not the worker. The repository's
`pnpm run test:live` can make up to 48 classifier requests and launches no worker; it is
not a full-chain check. Health/probe success does not guarantee a real task
meets the deadline. Receipt request counts record client attempts, not proof
of server receipt, completed inference, or billing.

Missing worker usage is `"unreported"`; `classifierUsage` is `"unreported"`
and `wholeRunUsageScope` is `"unverified"`. Snapshots are not whole-task costs
or savings. Offline doctor/help evidence does not prove runtime config-key
semantics, model entitlement, or paid benefit. A real worker using ChatGPT login
is not API-key billing or invoice evidence.
