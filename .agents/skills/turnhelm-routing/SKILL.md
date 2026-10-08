---
name: turnhelm-routing
description: Use when a Codex CLI or Claude Code agent needs Turnhelm project setup, readiness checks, or a separate model/effort-routed Codex child.
---

<!-- turnhelm-template v1 -->

# Turnhelm Routing

Turnhelm selects a model/effort pair and launches a separate Codex child. It
does not switch the current Codex/Claude Code session or its native subagents.
Use native tools when no separate Codex child is needed.

## Prepare and inspect a project

Commands use the current directory, or the exact directory passed with
`--project <dir>`; they never discover a parent config, even inside a Git
work tree. Requirements: Node >=22.8.0, Codex CLI >=0.160.0; `run` needs Git.

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
  immediately before that run. Routing is not write authorization. Review
  the resulting diff/tests and preserve unrelated changes.
- Every run selects among `fast`, `balanced`, `deep`, `frontier`,
  `frontier_xhigh`, `frontier_max`. Maximum effort is an ordinary automatic
  selection; no bypass, max flag, or extra stage exists. Failure means stop,
  not an unapproved model retry.
- Never run recursively when `TURNHELM_MANAGED_CHILD=1`.

## Backend and data boundaries

Laya is tried first when `backends.laya.enabled` is true. Hosted Jev requires **all three**:
`backends.jev.enabled: true`, `TURNHELM_ALLOW_HOSTED_JEV=1`, and a nonblank
`TYPESAFE_API_KEY`. Obtain explicit hosted authorization immediately before
use. Do not enable gates or edit config without approval; keep write/hosted
opt-ins out of reusable defaults. Laya may require `LAYA_API_KEY`.

The full task goes to the classifier: remove secrets and consider residency,
cost, and consent first. Keep keys out of prompts/logs/diffs/config. The child
does not inherit `LAYA_API_KEY`, `TYPESAFE_API_KEY`,
`TURNHELM_ALLOW_HOSTED_JEV`, or legacy `TURNHELM_CONFIG`.

## Interpret results

Worker output is on stdout; fixed diagnostics and one `turnhelm.receipt` JSON
are on stderr **once classification starts**. Input/config/preflight rejection
has no receipt. Read the exit code and routing/worker statuses, not stderr
presence or a selected profile alone.

To validate routing, submit the complete current requirement once, with
`--write` only for an explicitly approved edit; then review the actual receipt,
worker exit, scoped diff and checks. No forced profile or preliminary worker
is needed. Routing is sequential: Laya success means no Jev run request.
An authorized `doctor --probe` checks each eligible classifier separately,
not the worker. Health/probe success does not guarantee a real task meets the
deadline; a timeout with `worker.status: "not-started"` is a failure, not
successful delegation. Report it rather than silently changing gates/budget.

Missing worker usage is `"unreported"`; `classifierUsage` is `"unreported"`
and `wholeRunUsageScope` is `"unverified"`. Snapshots are not whole-task costs
or savings. Offline doctor/help evidence does not prove runtime config-key
semantics, model entitlement, or paid benefit.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| Using a parent project's config | Select the intended root explicitly. |
| Treating a read-only run/probe as offline | Authorize classifier requests separately. |
| Guessing a model after failure | Stop and report the failure. |
| Counting a receipt as success or total cost | Check statuses; keep usage scope unverified. |
