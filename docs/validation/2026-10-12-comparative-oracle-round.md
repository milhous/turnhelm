# Comparative oracle round (frozen design oracle 3) — 2026-10-12

Status: **predeclared before execution.** This file is committed before the
first worker run; results are appended in a second commit. It executes oracle 3
of the frozen [calibration design](2026-10-11-calibration-design.md) under the
user's 2026-10-12 plenary authorization for the deferred comparative worker
round — that authorization is the "fresh approval required" the design demands,
and it covers at most the four worker runs predeclared here.

## Protocol (predeclared)

- Pairs: `heading` (dev) and `decoy` (holdout), the two pairs with an
  executable single-line-edit form. `race` has no executable consumer fixture
  among the frozen artifacts (no codebase with the described
  transaction/enqueue race exists as a frozen case), and `auth` is review-only
  with no objective task-result oracle; neither runs a worker.
- Language: `en` for both pairs, one task text per pair within the two-run
  budget. `heading-en` is the RR-08 band-mismatch text (classifier selection
  `frontier`), so the overselection comparison lands on the exact text that
  motivated the finding. The `zh` siblings' selections are already recorded in
  the design's baseline appendix.
- Arms, at most two worker runs per pair:
  - **A — the classifier's selection**: the unmodified template
    `assets/config.json` profiles. Local Laya classifies (deterministic
    baseline: `heading-en` → `frontier` → gpt-6-astra/high; `decoy-en` →
    `balanced` → gpt-6.1-sol/medium) and the selected profile's model/effort
    runs.
  - **B — the band's lightest profile**: identical config except all six
    profile IDs are bound to `fast`'s pair (gpt-6-luna/low), the
    admission-case pattern. The classifier still classifies and its choice is
    journaled; whichever ID it selects resolves to gpt-6-luna/low.
- Task texts: verbatim from `test/fixtures/live-acceptance.json` `heading-en`
  / `decoy-en`. No prompt edits.
- Consumer roots: one fresh directory per run (`git init` + one commit of the
  fixture README + `.turnhelm/config.json`), identical fixture bytes across
  the arms of a pair. Runs are independent; no shared state.
- Classifier: local Laya only (`http://127.0.0.1:8765`, typed-decisions);
  `jev.enabled=false` in both configs. No hosted inference.
- Order: `heading` (dev) first, then `decoy` (holdout); within a pair, arm A
  then arm B.
- Caps and failure: exactly four worker runs total, no reruns, no replay, no
  retries, no budget changes. Any engineering failure (routing failure,
  worker spawn/protocol failure, evidence I/O failure) stops the round and is
  recorded as-is.
- Metrics per run: (a) task-result verdict from the objective diff oracle
  below, (b) receipt `worker.durationMs` (worker wall-clock), (c) receipt
  `worker.usage` token snapshot (`unreported` recorded as such). Routing facts
  come from the run receipt and `.turnhelm/routes.jsonl`.
- Accounting (per Investigation C5): workers run under the user's existing
  Codex CLI ChatGPT login; claims are bounded to ChatGPT-run counts, never
  API-bill amounts, savings percentages, or general quality. Any savings or
  sufficiency statement cites only this predeclared comparison.

## Frozen consumer fixtures (identical bytes for both arms of a pair)

`heading` consumer `README.md`:

```markdown
# Helm Console

Helm Console is a small operator dashboard for reviewing cluster state.

## Install

Run `make install` and start the server with `make serve`.

## Usage

Open http://127.0.0.1:8080 and sign in with your operator account.

## Support

File issues in the internal tracker; include the log excerpt.
```

`decoy` consumer `README.md`:

```markdown
# Relay Toolkit

Relay Toolkit forwards structured events between internal services.

## Quick start

`relay start --config relay.toml` begins forwarding on the configured topics.

## Security architecture

Events are authenticated per producer with rotating keys; tokens expire hourly
and revocations propagate through the shared session store within one minute.

## Monitoring

Relay exposes a Prometheus endpoint at /metrics on the internal port.
```

## Task-result oracle (objective, profile-blind)

A run passes iff, after the worker completes:

1. `git status --porcelain` reports only `README.md` modified, and
2. the `git diff` change is exactly one deleted line and one added line —
   - `heading`: `# Helm Console` → `# Turnhelm`
   - `decoy`: `## Security architecture` → `## Security`

and the receipt reports `worker.status: "completed"`. Anything else (wrong
line, extra lines, new/removed files, failed worker) is a recorded failure.
The oracle never considers which profile produced the diff.

## Results (appended after execution)

To be recorded per run: pair, arm, classifier profileId (journal), executed
model/effort, task-result verdict, `durationMs`, usage snapshot, exit code.
