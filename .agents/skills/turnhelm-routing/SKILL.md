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
`TURNHELM_ALLOW_HOSTED_JEV`, legacy `TURNHELM_CONFIG`, and the
startup-file keys `BASH_ENV`/`ENV`, and redirects
`ZDOTDIR` to the managed `.turnhelm` root so a zsh descendant does not source
the host `~/.zshenv` (a missing startup file there is zsh's skip state). This
is still not host filesystem secret isolation: other shells' startup files,
absolute reads of host files, or a key exported by another mechanism remain
outside this boundary. Do not read key values or change authentication/shell
settings to make a check pass.

## Interpret results

Worker output is on stdout; fixed diagnostics and one `turnhelm.receipt` JSON
are on stderr **once classification starts**. Input/config/preflight rejection
has no receipt. A failed worker turn prints exactly one fixed
`turnhelm: worker-failed: <class>` line — class from a frozen taxonomy,
never native error text. The receipt's `worker` object always carries
`ownedShutdown`, a boolean action record (a parent-initiated stop ladder
ran), not a causation claim; a failed worker adds `failureClass` and
`errorSha256` (hash only), and any death by SIGINT/SIGTERM/SIGKILL —
failed or cancelled — adds the `signal`. Every worker receipt also carries
`progressEvents` — the count of event frames the parent successfully
decoded, malformed frames excluded — and, once at least one decoded,
`lastEventAgeMs`, the rounded milliseconds from that last decode to
settlement; both are parent-observed, backpressure-bounded observations,
never liveness or stall claims. Read the
exit code and routing/worker statuses, not stderr
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
`pnpm run test:live` is a two-step acceptance run: an offline `--prepare`
spends nothing and freezes a manifest a human must read and approve by
sha256 before `--execute` spends the reserved per-suite caps (classifier
requests: laya ≤ 7, jev ≤ 1, dual ≤ 2 per backend, calibration-dev and
calibration-holdout ≤ 12 each; workers: laya ≤ 7, jev ≤ 1, dual ≤ 2, and the
calibration suites 0). Each manifest covers exactly one suite, claims once —
never replayed or resumed — and the
evidence journal stores bounded fixed fields only, degrading unknown receipt
data to `invalid`/`unknown`, with one deliberate exception: each judged case
retains its `oracleInput` — the exact oracle-judged stdout or summary bytes,
bounded to 64 KiB, private to the claimed run; that is raw-content retention,
not secret sanitization. Observed records also carry a whitelisted
`workerUsage` projection whose scope is unverified, and a bounded
`workerFailure` projection — frozen class, `ownedShutdown` boolean,
optional correlation hash and death signal; no failure text — plus
`workerProgress`, the receipt's decoded-event count and, when one decoded,
the last decode's age at settlement, the same parent-observed projection
that never claims liveness. The harness also exports its shared oracle
primitives — the payload-agnostic `envelopePayload` envelope fact and the
root-parameterized `oracleSandboxPolicy` sandbox profile — so sealed-round
tooling and tests judge against one frozen definition instead of two that
drift. Exit `3` means a complete
calibration roster with a band-policy mismatch; exit `4` means a complete
worker roster with at least one engineering failure. A task-output failure
(wrong or missing output, every integrity check true) fails the case and the
approved roster continues; any integrity failure — including a replaced
consumer root, caught by `root-identity` — stops immediately. A `completed`
record plus the exit code is a convenience status only: acceptance reconciles
case IDs, verdicts, counts, the absence of a terminal `stopped`, and the
process exit — the 2026-10-12 validation findings stay open until a fresh
live run passes them.
Cancelling signals only the owned CLI child
(SIGINT, then SIGTERM after a fixed grace); left-behind descendants are not
scanned or killed, and a child that still never closes stops the round as
`cleanup-unverified` rather than hanging. Health/probe success does
not guarantee a real task meets the deadline. Receipt request counts record
client attempts, not proof of server receipt, completed inference, or billing.

Missing worker usage is `"unreported"`; `classifierUsage` is `"unreported"`
and `wholeRunUsageScope` is `"unverified"`. Snapshots are not whole-task costs
or savings. Offline doctor/help evidence does not prove runtime config-key
semantics, model entitlement, or paid benefit. A real worker using ChatGPT login
is not API-key billing or invoice evidence.

The checkout also carries a hermetic custom-round runner — `test/custom-round.ts`,
exported through the built `dist/test` surface — for owner-defined validation
rosters. The round input is a data-only JSON roster: nothing executable is
trusted from it, and every referenced file is hashed into a frozen manifest as
data. `prepareRound` validates the roster, re-verifies the pinned HEAD and
consumed-file baseline, runs local sandboxed preflights, and writes the
manifest with a human approval request while spending nothing — zero classifier
requests and zero worker executions, asserted by the manifest's zero-spend
block. `executeRound` runs only under the human-approved sha256: it re-verifies
manifest bytes, evidence-root identity, runtime, HEAD, and baseline, claims the
append-only evidence ledger exactly once (a replay refuses), and gates every
case identity-before-spend — root dev/ino identity and frozen file hashes must
re-verify before any launch. Task-output and contract-assertion failures fail
their case and the roster continues to exit `4`; integrity failures (identity
drift, timeout, output cap, cleanup, check infrastructure) and auth-, rate-
limit-, or usage-limit-class worker receipts stop all remaining spend with exit
`1`; a roster whose planned spend exceeds its frozen caps is refused before
launch; the first SIGINT settles gracefully with `130` and SIGTERM with `143`.
Worker-write contracts execute inside the runner's sandboxed check launcher,
whose single marked outcome line replaces exit-code and stderr inference; the
sandbox boundary is a path-injected fake on every platform, with a real
seatbelt profile only in the macOS-gated test. Two harness pins landed with it:
acceptance-style tests observe actual fake-worker invocations rather than
reserved records, and the worker receipt's `lastEventAgeMs` is pinned positive
through a post-drain settlement gap.
