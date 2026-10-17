# Worker Boundary Live Verification Plan (deferred items)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Authorization note:** Tasks 1–3 spend real classifier/worker budget. This plan is written, not
> executed; execution begins only on the user's explicit per-campaign go-ahead with finite manifest
> caps, exactly like `pnpm run test:live`. Task 0 is offline and free.

**Goal:** close the three verification gaps the offline arc left open (spec §4 closing note, §7, §8):
(1) behavioral proof that the enforced set — managed home + `--ignore-user-config --ignore-rules
--ephemeral` — actually suppresses ambient codex config on a real worker; (2) real credential-refresh
write-through through the symlinked `auth.json`; (3) a re-derivation protocol for the §7 matrix so a
codex bump cannot silently invalidate it.

**Spec:** `docs/superpowers/specs/2026-10-16-worker-boundary-and-output-contract-design.md` — §7 is
the matrix this plan verifies; §8 records why these items are deferred.

## Global Constraints

- Zero paid calls without an approved finite manifest (caps declared per task below); offline first.
- No `--dangerously-bypass-hook-trust`, ever. No login/proxy/authentication changes.
- Host `~/.codex` is read only where named; the plan never writes it. Concurrency tests use a
  throwaway copy of `auth.json` in a temp parent home, never the live login file.
- Every finding updates the spec (matrix row or residual) — evidence that does not change the doc
  was not worth the spend.
- Conventional Commits; do not merge to main (user merges personally).

## Task 0 — codex-bump matrix re-derivation (offline, free)

When the pinned codex version moves (preflight floor or observed binary), re-derive §7 before any
live spend:

- [ ] Run `codex exec --help` / `codex --help` on the new binary; diff against the flag text quoted
      in §7 rows (config.toml, profiles, `.rules`, `AGENTS.md`, hooks, MCP, sessions, credentials).
- [ ] Re-run the `codex debug prompt-input` both-ways marker probe (§7 row 4) if the subcommand
      still exists; if isolation flags are newly accepted, add the enforced-set behavioral check the
      0.162.1 closing note could not.
- [ ] Update §7 rows in place with the new version stamp; any channel that changed mechanism gets a
      ledger note in the spec.

**Expected:** §7 names the new version with every row re-checked; no code change unless a channel
moved.

*Executed 2026-10-17: no bump — installed codex-cli still 0.162.1, the §7 stamp; nothing to re-derive.*

## Task 1 — enforced-set behavioral probe (live, ≤2 worker runs)

Design: one marker task, run twice through `turnhelm run` against a project whose parent
`CODEX_HOME` carries a hostile `config.toml` (a `[model]` pin and an `AGENTS.md` marker paragraph).
The task asks the worker to echo the instructions it can see. Assertions read only the final message
and receipt:

- [x] With hostile parent home: the marker text is absent from the worker message and the receipt
      carries `codexHomeManaged: true` (the enforced set held on a real binary).
- [x] With the project `AGENTS.md` marker (intended channel, §7 row 5): the marker is present —
      proves the probe would have seen a suppressed channel, not a deaf worker.

**Expected:** both directions recorded in the spec §7 note as live-verified, with the codex version.

## Task 2 — credential refresh write-through (live, 1 worker run)

- [x] Copy the current `auth.json` to a temp parent home; point the run's `CODEX_HOME` there.
- [x] One long-enough real run; afterward the temp `auth.json` mtime/content changed only by token
      refresh (never a second file inside the managed home), and the run completed.
- [x] Offline concurrency pin already holds (spec §4 item 3); record here only what a real refresh
      cycle adds — write-through through the symlink on a live binary.

*Executed 2026-10-17: run completed; source credential byte-identical after (sha256 unchanged, mtime
unchanged) — no refresh cycle occurred in this run, so live write-through stays unobserved and the
offline pin remains the only claim; the mid-run no-second-copy listing was not captured (poll-script
glob bug) and is not claimed.*

**Expected:** one line in spec §3 WB-2 upgrading "inherited semantics" to "live-observed", or a
finding if refresh broke.

## Task 3 — reconcile with the routing-validation campaign

- [x] The campaign the user authorized separately owns the broad acceptance matrix; its receipts
      already carry `codexHomeManaged`. Fold Task 1–2 evidence into the same campaign root instead
      of a new one when timing allows.
- [x] Re-check the 2026-10-12 validation findings list against the campaign outcome; anything the
      boundary work closes gets marked, anything still open stays named.

*Executed 2026-10-17: the routing-validation campaign (330ff37) is still offline-prepared awaiting
SHA approval, so this plan's evidence lives in its own root (`boundary-live-20261017-100326`) and
folds in when that campaign runs. The 2026-10-12 findings list is unchanged by this plan — with one
interpretive note: all three of this plan's completed runs settled as `code: 143` + `ownedShutdown:
true` (parent stop ladder after the terminal event), the by-design completed shape; the
native-worker-143 findings must distinguish this shape from genuinely failed 143 exits.*

**Expected:** one evidence root; spec residuals list shrinks or stays with reasons.

## Review Focus

The input classes this plan's checks must survive: a codex version whose flag text changed (Task 0
catches before spend); a worker that echoes instructions it was given rather than all it saw (the
row-5 positive control catches it); a refresh that rewrites `auth.json` by rename (breaking the
symlink) rather than in place — watch for that explicitly in Task 2 and treat it as a finding, not a
flake.
