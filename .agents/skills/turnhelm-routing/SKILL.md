---
name: turnhelm-routing
description: Use when Turnhelm appears at all — preparing or inspecting a Turnhelm project, executing an authorized task in a separate model/effort-routed Codex child, reviewing route decision evidence (receipt, routes.jsonl), or operating the custom-round validation harness (rosters, evidence ledgers, stop semantics). Also use it whenever the user asks to classify, route, or delegate a self-contained coding task to a selected model/effort profile, even without naming Turnhelm.
---

<!-- turnhelm-template v1 -->

# Turnhelm Routing

Turnhelm selects a model/effort pair and launches a separate Codex child. It
does not switch the current Codex/Claude Code session or its native subagents.
Use native tools when no separate Codex child is needed.

## Prepare and inspect a project

Commands use the current directory, or the exact directory passed with
`--project <dir>`; they never discover a parent config, even inside a Git
work tree. Requirements: Node >=24.5.0 (24.0 support dropped; the CLI refuses
older runtimes before any work; validation on an actual 24.x >=24.5.0), Codex
CLI >=0.160.0; `run` needs Git.

| Command | Effect |
| --- | --- |
| `turnhelm init --dry-run [--project <dir>]` | Inspect installation; write nothing. |
| `turnhelm init [--project <dir>]` | Install config, shared skill/metadata, and managed AGENTS block. |
| `turnhelm doctor [--json] [--project <dir>]` | Offline checks; no classification or worker. |
| `turnhelm doctor --probe [--project <dir>]` | One synthetic request per eligible backend; no worker. A failed probe's evidence carries the last observed HTTP status with fixed guidance. |

The sole config is `.turnhelm/config.json` (v2): `routingTimeoutMs`,
`backends.laya`, `backends.jev` — whose `transport` is required, exactly
`{ "mode": "direct" }` or
`{ "mode": "http-connect", "proxyUrl": "http://127.0.0.1:<port>" }` with a
literal loopback host (`127.0.0.1` or `[::1]`) and an explicit decimal port —
and six `profiles`; unknown keys are rejected. A version-1 or
transport-missing config is refused before classification; nothing is
migrated or rewritten automatically — the owner reviews and replaces it with
a v2 config (or removes it and re-runs `init`, which preserves unrelated
files). Transport policy is never filled from environment proxy variables.
`init` preserves valid config and unrelated AGENTS text; repeated identical
installation is a no-op. Conflicting or changed skill files are refused,
not overwritten. Stop for owner reconciliation, not automatic deletion.
Restart existing Codex sessions after installation. Missing config is a
doctor failure; offline eligibility is not reachability or model access.
Obtain request/data authorization before `--probe`; it is not an offline check.

## Existing local Laya

If Laya 0.4.8 serve dependencies and `typed-decisions` weights are already
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
  resulting diff/tests and preserve unrelated changes. Read-only denies
  writes, not reads — host permissions still govern any specific file; the
  2026-10-17 campaign observed a worker claim a read-only session cannot
  read files (cause unresolved).
- `--output-schema <file>` (opt-in) hands Codex a JSON Schema for the final
  message: a readable regular file (symlinks refused), at most 65536 bytes,
  strict UTF-8, one JSON object, validated once at the input boundary and
  staged inside the run's managed home — the caller's path is never forwarded
  or re-read. `payload.mode` still reports framing only; schema conformance
  stays the consumer's acceptance gate.
- `--lifecycle` (opt-in) records a bounded, content-free worker timeline — a
  frozen event taxonomy (spawned through settle) with millisecond ages, never
  worker output, task text, or error prose. The executed-worker receipt
  carries a `lifecycle` projection of at most 64 events (with an `overflow`
  marker), and each event is appended best-effort to
  `.turnhelm/lifecycle.jsonl`; a journaling failure never fails the run, though
  fire-and-forget appends may briefly hold the event loop at exit.
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
opt-ins out of reusable defaults. Laya may require `LAYA_API_KEY`. A proxy
transport grants neither hosted nor write authority; those stay separate
consents.

Transports are explicit per backend. Laya is always direct to its loopback
origin. Jev rides the configured `transport`: direct HTTPS to the fixed
`https://api.typesafe.ai/v1/systemone` origin, or `http-connect`, where the
loopback proxy sees only a CONNECT to `api.typesafe.ai:443` and the
authorization/body travel inside verified TLS — never in CONNECT headers.
Environment/system proxies are never inherited; each request owns one scoped
agent and destroys its request, response, and sockets (including a pending
CONNECT tunnel) on every outcome. Transport failures fail closed with no
retry, redirect, or direct fallback.

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

Every run also builds a worker instruction boundary on the codex side: a fresh
per-run `CODEX_HOME` plus `--ignore-user-config --ignore-rules --ephemeral`,
suppressing the ambient codex channels rooted in `CODEX_HOME` and the user
profile (config.toml, profiles, `.rules`, the home's `AGENTS.md`, hooks, MCP
servers, sessions); the remaining instruction surface is the task, the cwd
project tree, and Turnhelm's argv. The managed home is initialized with only
the staged output schema and,
when a source exists, a symlink to the parent `auth.json` (never copied;
codex itself may add scratch there);
executed-worker receipts carry `codexHomeManaged: true` as a mechanism
attestation, not an isolation claim. A run with no discoverable credential
(no `auth.json` at the parent-derived source, no exported `OPENAI_API_KEY`)
is refused before classification. Enforced ≠ exhaustive: `$HOME/.agents/skills`
discovery, managed/admin hook layers outside `CODEX_HOME`, other shells'
startup files, and a project `AGENTS.override.md` remain residuals outside
this boundary — documented, not closed.

## Interpret results

Completion is not verification: a `completed` worker (exit 0) proves the child
finished its turn, never that the task was done — consumer gates (output
schema, oracle/contract checks, diff review) judge that.

Worker output on stdout is at most one message — the final agent message of
a completed run; earlier progress messages are discarded; fixed diagnostics
and one `turnhelm.receipt` JSON are on stderr **once classification
starts**. The message is classified at emission: one JSON value is emitted
verbatim (`payload.mode: "strict"`); a payload line plus inert trailing
prose yields exactly the payload line (`"extracted"`, with `trailerBytes`
in the receipt — the dropped trailer is retained nowhere); further
structured content after the payload line, or any non-JSON message, is
emitted verbatim (`"conflict"` / `"unstructured"`); every emission is the
classifier's text plus one appended newline. The boundary is a
delimitor, not a validator, and still not a redactor; success is read from
the exit code and receipt, never stdout presence. Observed worker failure
modes (2026-10-17): wrong refusal, claimed completion with the
implementation unchanged, schema-valid but value-wrong output — all
consumer-gated. Input/config/preflight rejection
has no receipt. A failed worker turn prints exactly one fixed
`turnhelm: worker-failed: <class>` line — class from a frozen taxonomy,
never native error text. The receipt's `worker` object carries
`ownedShutdown` — a boolean action record (a parent-initiated stop ladder
ran), not a causation claim — only once a worker actually executed; a
`not-started` worker object has no action fields. A failed worker adds
the frozen `failureClass` and, only when a native error message existed,
`errorSha256` (hash only); any death by SIGINT/SIGTERM/SIGKILL —
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
(never the task text), the routing status, per-backend attempts with their
transport mode (`direct` or `http-connect` — recorded policy, not proof of the
proxy's actual exit), and, on
selection, the backend, profile, model, effort, and the classifier's
`confidence` when the backend reports one. Journaling is best-effort: an
unwritable or non-regular journal path (symlink, FIFO) is diagnosed
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
eligible classifier separately, not the worker, through the same shared
request boundary, eligibility gates, and Jev transport policy as `run`. The repository's
`pnpm run test:live` is a two-step acceptance run: an offline `--prepare`
spends nothing and freezes a manifest a human must read and approve by
sha256 before `--execute` spends the reserved per-suite caps (classifier
requests: laya ≤ 7, jev ≤ 1, dual ≤ 2 per backend, calibration-dev and
calibration-holdout ≤ 12 each; workers: laya ≤ 7, jev ≤ 1, dual ≤ 2, and the
calibration suites 0). `--prepare` accepts `--config <file>` (an owner-reviewed
v2 config read once and frozen into the manifest; execution never rereads it,
and a refusal leaves no run root) and, for `dual` only,
`--case dual-jev-write`; unknown, duplicate, or missing prepare flags are
refused. The two specialized forms:

```sh
node dist/test/live.integration.js --prepare jev --config ./acceptance-config.json
node dist/test/live.integration.js --prepare dual --config ./acceptance-config.json --case dual-jev-write
```

are future offline preparation examples, not commands to run now and not
authorization to supply credentials. Each yields a separate fresh-sha256
singleton (`jev` caps `{worker:1, laya:0, jev:1}`; the dual form
`{worker:1, laya:1, jev:1}`), read and approved separately. Gate the pair
manually: readonly Jev first; only its exit 0, complete records, and matching
transport evidence open the write case, and any first failure closes it — no
extra probe, worker, or retry between them, and two passes still would not
resolve the open band/optimality/billing findings. Each manifest covers exactly one suite, claims once —
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
that never claims liveness. A failed or timed-out case additionally carries
`workerLifecycle` — the bounded content-free worker timeline (`tMs` and
`kind`, plus at most a fixed-vocabulary `detail` such as the observed
failure class; at most 64 events) projected from the receipt's `lifecycle`
field, or rebuilt from the best-effort `.turnhelm/lifecycle.jsonl` journal by
the supervised CLI's pid when the CLI died before receipting; completed runs
carry none. Records also carry `attemptTransports`, a bounded
per-attempt backend/transport-mode projection (Laya always direct; any
missing, duplicate, or invalid data reads `unverified`) — frozen application
policy, never a proxy-exit attestation, and never a gate for ordinary cases:
only `jev-default-readonly` and `dual-jev-write` must match their frozen
config. The harness also exports its shared oracle
primitives — the payload-agnostic `envelopePayload` envelope fact and the
root-parameterized `oracleSandboxPolicy` sandbox profile — so sealed-round
tooling and tests judge against one frozen definition instead of two that
drift. Each worker-suite case freezes its own integer `deadlineMs`
(5000–3600000 ms) at prepare and may carry its own output schema through the
same CLI flag; an expired deadline is an unjudged `timeout` verdict behind
custom-round's three gates — the CLI closed cleanly, exactly one CLI receipt
(a receiptless timeout stops the round with its crash evidence retained), and
a settled tree — never a stop by itself. Exit `3` means a
complete calibration roster with a band-policy mismatch; exit `4` means a
complete worker roster with at least one failed or timed-out case. A
task-output failure (wrong or missing output, every integrity check true)
fails the case and the approved roster continues, as does an unjudged
per-case timeout; any integrity failure — including a replaced
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
unless a Laya selection carries its bounded `input_tokens`/`state_tokens`
projection — evidence that never gates an outcome; hosted Jev never projects.
`wholeRunUsageScope` is `"unverified"`. Snapshots are not whole-task costs
or savings. Offline doctor/help evidence does not prove runtime config-key
semantics, model entitlement, or paid benefit. A real worker using ChatGPT login
is not API-key billing or invoice evidence. Hermetic admission suites rebind
profile mappings per tuple, so they evidence execution under a forced pair,
never natural selection; any six-profile natural-coverage claim requires
natural runs with unchanged mappings, reported with actual selections and
remaining gaps.

The checkout also carries a hermetic custom-round runner — `test/custom-round.ts`,
exported through the built `dist/test` surface and invocable as
`node dist/test/custom-round.js prepare <roster.json>` / `execute <manifest.json>
<sha256>` — for owner-defined validation rosters. The round input is a
data-only JSON roster: nothing executable is trusted from it, and every
referenced file is hashed into a frozen manifest as data, alongside a per-case
snapshot of the whole consumer tree. Each roster case carries a required
integer `deadlineMs` (5000–3600000 ms) that the runner supervises the case CLI
under, and may carry an `outputSchema` file frozen with the same hash record.
`prepareRound` validates the roster,
re-verifies the pinned HEAD and the whole-consumption baseline (every built
module the round executes), preflights the sandbox machinery and each roster
contract's loadability, and writes the manifest with a human approval request
while spending nothing — zero classifier requests and zero worker executions,
asserted by the manifest's zero-spend block. `executeRound` runs only under
the human-approved sha256: it re-verifies manifest bytes, evidence-root
identity, runtime, HEAD, and baseline, claims the append-only evidence ledger
exactly once (a replay refuses), and gates every case identity-before-spend —
root dev/ino identity, frozen file hashes, the frozen tree, and the consumed
baseline re-verify before each reservation, and a reserved record that cannot
be written stops all remaining spend. A run must carry exactly one CLI receipt
to be graded; journal backend/profileId values surface only through a fixed
whitelist; a legal profile outside the case's allowedProfiles fails its case;
and each judged case retains its bounded `oracleInput`. After the worker runs,
a fixed decision order holds: abort; unverified cleanup (a possibly-live CLI,
stop `cleanup-unverified`); output cap (stop `output-cap` — overflow also
raises the timeout flag, which is why it is decided first); exactly one CLI
receipt (anything else stops `receipt`); auth-, rate-limit-, and
usage-limit-class receipts (stop `worker-<class>`); timeout; then grading.
Every case then passes the same settled-tree gate — root dev/ino plus
canonical-path re-check and a re-hash against the case's allowedChanges —
graded or timed out: a same-content root replacement stops `root-identity`,
and a write outside the allowance stops `tree-drift`, even when the output
graded fine. The same identity rule binds the frozen inputs: every
roster-referenced file — including a case's `outputSchema` — re-verifies
dev/ino plus bytes at the pre-spend gate, and the oracle's consumed inputs
(contract, task file, hooks) re-verify again around the sandboxed contract
check, so a byte-identical rebind of an oracle or contract
file stops `oracle-identity` before any spend, while a mutated or missing
file stops `case-files`. A timeout is an unjudged per-case outcome, not a stop
(`outcome:"timeout"`): no oracle grading and no contract check, and after the
settled-tree gate its case record is appended and the roster continues to the
next reservation. Every case record (pass, failed, or timeout) and the
post-CLI stop records (`cleanup-unverified`, `output-cap`, `worker-<class>`,
`tree-drift`, `root-identity`; not the `receipt` stop, which has no single
receipt to project) carry a `workerFailure` whenever the lone receipt's
worker object is projectable (absent, non-record, or an out-of-enum status
omits the field, never fabricates it): a per-field projection of the
run's single receipt worker object — a frozen status enum plus optional
`code`, `durationMs`, `progressEvents`, `ownedShutdown`, `usage`,
`failureClass`, `errorSha256`, `signal`, and `lastEventAgeMs`. Unselected
receipt keys (such as the worker `payload`) are ignored, malformed fields are
dropped individually and never coerced, and `errorSha256` is correlation-only
— no error text or stderr bytes are retained; zero-valued counters stay as
observations (`progressEvents:0` means zero decoded frames). These are
parent-observed counts and ages and an action record for `ownedShutdown` — no
liveness, stall, or causation claims ride them. Terminal evidence appends are
load-bearing: a case record the ledger cannot take stops the round
(`stopped {reason:"evidence-io"}`, exit `1`), and after the last case a
`completed` record (`{phase:"completed", outcome:"pass"|"fail", cases, failed,
timedOut}`) reconciles the case records actually written, while a signal
discovered after the last append still settles `130`/`143` rather than a
would-be `0`/`4`. Task-output and contract-assertion failures fail their case
and the roster continues. Exit semantics: `0` complete all-pass; `4` complete
roster with one or more `failed` or `timeout` cases; `1` every stop and
refusal — identity, baseline, or tree drift, receipt count, output cap,
cleanup, check infrastructure, stopping worker receipts, and usage or prepare
refusals — custom-round never exits `2`, and `3` is calibration-only and never
emitted by custom-round; a roster whose planned spend exceeds its frozen caps
is refused before launch; SIGINT anywhere in the round, including
mid-contract, settles gracefully with `130` and SIGTERM with `143`. Campaign
drivers must continue only on `0`, `3`, and `4` and halt on everything else —
`1`, `130`, `143`, and any unexpected code — and a per-case worker CLI exit
of `143` is a graded case outcome inside a manifest, never a campaign-process
`143`. Worker-write contracts execute inside the
runner's sandboxed check launcher, whose runner-owned fd-3 outcome record
replaces exit-code and stdout inference; the launcher drives
`/usr/bin/sandbox-exec` with a generated seatbelt profile (macOS), the
hermetic tests substitute a path-injected fake on every platform, and only
the macOS-gated test exercises the real profile. Two harness pins landed with it: acceptance-style tests
observe actual fake-worker invocations rather than reserved records, and the
worker receipt's `lastEventAgeMs` is pinned positive through a post-drain
settlement gap. Roster authoring rule: an oracle whose verdict depends on
ordering, ties, or direction — sort order, first-match, prefix direction —
must state the direction it judges and include one worked example with tied
inputs, so a mis-graded tie is caught by the roster itself; a task whose
oracle verdict depends on when an effect must happen — a synchronous throw
versus a deferred rejection, a same-turn identity window for promises or
handles, state visible before versus after settlement,
retry-after-settlement semantics — must state the timing policy it judges
and include one worked call-order example exercising the ambiguous boundary
(for a fetch that throws synchronously: whether the immediately following
same-key call must return the identical promise, and whether rejection is
deferred to a microtask), with the task text imposing exactly the policy the
oracle judges; sealed oracles
and recorded grades are never edited after the fact — a defective oracle is
retired and replaced, not rewritten.
