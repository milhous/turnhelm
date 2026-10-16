# Worker Instruction Boundary and Explicit Output Contract Spec

Date: 2026-10-16. Code baseline: `ac22dbb67d2f4e89dd8d5bb9315da427ab20` (main, clean). Input: the sealed
routing-validation campaign report (`/Users/zhangxiao/.local/state/turnhelm/validation-20261016-ac22dbb-cad7t7jr/REPORT.md`,
verdict COMPLETE-WITH-FAILURES, 87/90 pass) and its offline root-cause supplement
(`/Users/zhangxiao/.local/state/turnhelm/rca-ac22dbb-20261016-Om5qRs/ROOT-CAUSE-ANALYSIS.md`). Revised after the
2026-10-16 astra re-check (§6: 3×P1, 4×P2, all adjudicated).

> Status: drafted under the user's authorization to write this spec, re-check it through one codex worker
> (`gpt-6-astra` — the single paid call this work makes, §6), update it from that review, and write an execution
> plan. That authorization does not extend to code implementation or publication. Constraints fixed by the user:
> optimize for long-term benefit, safety, and performance only; backward compatibility is explicitly not maintained.

## 1. Findings and decision boundary

The three campaign failures are task-delivery failures that completed cleanly at the transport level (all exit 0,
`completed`, owned shutdown). The RCA localizes them into three distinct gaps:

| Case | Failure | RCA localization |
| --- | --- | --- |
| 33-rollout | correct JSON answer followed by same-line prose → `payload.mode: "unstructured"` | the worker's effective instruction context is not isolated: `subprocessEnvironment` preserves `HOME`/`CODEX_HOME` and argv disables no global instructions/plugins/hooks (RCA §3B). A Ponytail-style footer requirement is a supported hypothesis, not a proven cause — but the channel is open by construction. |
| 11-url | completion JSON valid, `module.mjs` byte-identical to the placeholder fixture | native completion is not acceptance (RCA §3A): `completed` + exit 0 proves turn termination, never task correctness. The harness already closes this at the consumer boundary (`test/custom-round.ts` sandboxed contracts); the product docs never state the boundary. |
| 39-discount | reversed tie comparator fails the frozen oracle | task-spec ambiguity: the task said `breaking ties by code-point id` without a direction or a tied example; the oracle encodes ascending (RCA §2.3). A fixture-authoring gap, not a code defect. |

Also recorded, and explicitly **not** acted on here: backend fallback is not semantic-quality recovery and profile
optimality is unmeasured (RCA §3C/§3D). The RCA forbids automatic retries, confidence thresholds, and forced
expensive tiers on this evidence; those stay non-goals (§5).

| Approach to the open instruction channel | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: explicit argv isolation (`--ignore-user-config`, `--ignore-rules`) **plus** a per-run managed `CODEX_HOME` containing only credential material | closes by construction every channel rooted in `CODEX_HOME` (config.toml, plugins, hook trust, global instruction files, MCP servers) and the execpolicy `.rules` channels; one temp-dir setup and removal per run; receipt attests the enforced mechanism set | **Adopt** |
| B: argv flags alone | correct only if flag coverage is verified complete for every codex release (flag help scopes `--ignore-user-config` to `config.toml`; the review confirmed global `AGENTS.md` suppression and the user hook layer are **not** established guarantees of the flag) | Reject |
| C: filter or rewrite the host config before forwarding | means parsing and editing a config format turnhelm does not own; a partial copy is a new divergence class; strictly more code for less assurance than an empty home | Reject |
| D: define and enforce a *complete* ambient-context boundary (every HOME-rooted instruction, skill, and hook source codex can load) | stronger on paper, but no verified control set exists for it today; promising it would overstate what any offline test can prove | Reject as scope; the channels are enumerated and documented as residuals (§3 WB-2, DC-1) and revisited only with verified controls |

Not maintaining backward compatibility means: argv-pinning and environment-pinning tests are rewritten to the new
boundary; a host `config.toml` that previously reached the worker (custom providers, MCP servers, plugin grants)
no longer does, by design; a login mode that resolves nowhere under the managed configuration now fails before
spend with a fixed diagnostic instead of failing inside the worker. It does **not** mean weakening the sandbox,
the approval posture, or the evidence discipline — every existing invariant listed in §2 is inherited unchanged.

## 2. Scope, inheritance, and invariants

Files changed: `src/codex.ts` (`buildWorkerArgs`, `workerEnvironment`, `executeWorker` lifecycle), `src/cli.ts`
(flag parsing, schema staging, receipt projection), `src/preflight.ts` (`REQUIRED_CONTROLS`, credential-source
check), `test/worker.test.ts`, `test/cli.test.ts`, `test/preflight.test.ts`, `README.md`,
`.agents/skills/turnhelm-routing/SKILL.md`. No functional change to `test/custom-round.ts`,
`test/live-acceptance.ts`, routing, classifier, config, transports, or journal: the harness ignores unselected
receipt keys by construction, so the one new receipt field (WB-4) requires no harness change.

Inherited unchanged: env stripping in `subprocessEnvironment` (keys, `BASH_ENV`/`ENV`, `NODE_V8_COVERAGE`
discipline); `ZDOTDIR` redirect; `TURNHELM_MANAGED_CHILD`; terminal-event settlement and the owned TERM→KILL
ladder; PE-1 payload classification at emission (strict/extracted/conflict/unstructured, no redaction, no
validation); sticky-failure irreversibility; exit-code discipline; one-worker-per-run; frozen failure taxonomy;
8192-byte task bound; the sealed campaign's grades and closed authorities.

## 3. Design

### WB — worker instruction boundary

**WB-1 Explicit argv isolation.** `buildWorkerArgs` appends `--ignore-user-config` and `--ignore-rules` to the
existing `exec --ephemeral --json --sandbox … --config agents.enabled=false …` vector. Established semantics
(codex 0.162.1 `exec --help`): the host `$CODEX_HOME/config.toml` is not loaded, and user/project execpolicy
`.rules` files are not loaded. Ambient configuration that could grant approvals or inject instructions is removed
in **both** directions — the per-run `--sandbox` argv becomes the sole execution-policy boundary. Not established
by the flag (review d1/d3): suppression of `CODEX_HOME/AGENTS.md` or `AGENTS.override.md`, and the user hook
layer — those are closed by WB-2's empty home instead (and, for hook *trust* state, by there being nothing to
trust). `--ignore-rules` stays even though WB-2 empties the user-rules channel: it also covers `.rules` files in
the project tree, which WB-2 cannot reach, and removes them deterministically over inheriting them.

**WB-2 Per-run managed `CODEX_HOME`.** Before spawn, `executeWorker` creates
`mkdtemp(join(tmpdir(), "turnhelm-worker-"))` (path join — `tmpdir()` carries no trailing-separator guarantee)
and sets `CODEX_HOME` to it in the worker environment, overriding any inherited value. The directory's intended
contents are exactly: (1) an optional `auth.json` **symlink** — never a copy: no second secret on disk, no
cleanup of secret bytes, and refresh writes flow through to the single real file — to the parent's auth file
(parent `CODEX_HOME` when set, otherwise `~/.codex/auth.json`), created only when that file exists; and (2) the
staged `output-schema.json` of an OC run (OC-1). Nothing else is created by turnhelm; codex may write its own
scratch inside the fresh writable home (`--ephemeral` keeps session persistence out regardless).

*Credential resolution, stated honestly (review P1-3):* the supported credential modes under the managed
configuration are (a) file-backed login via the symlinked `auth.json` and (b) an API key in the environment.
Anything else (OS-keyring-backed login, modes that resolve nowhere under the managed home) is unsupported and
must fail visibly rather than silently: preflight/run-start checks, before classification and spend, that at
least one credential source is discoverable — the auth file at the expected source location or an
`OPENAI_API_KEY` in the worker-bound environment — and refuses with a fixed diagnostic otherwise. Token refresh
writes through the symlink to the real file; concurrent runs share that file exactly as they share `CODEX_HOME`
today, so refresh and concurrency semantics are inherited, not newly introduced. Write-through and
no-second-copy behavior are pinned offline (§4 item 3); live refresh behavior is verified only in a future
authorized campaign, and the spec claims no more than that.

*Lifecycle:* creation failure fails closed with the existing `spawn` failure class — there is no fallback to the
inherited home. The directory is removed recursively **after settlement discharge** (owned shutdown complete,
`closed` observed — never racing native writes), on every path: completed, failed, cancelled, spawn-error, and
symlink-setup failure mid-creation. `rmSync` unlinks rather than follows the `auth.json` symlink (pinned, §4
item 3); the real credential file is never touched by cleanup. A hard kill can still leak one 0700 temp
directory whose contents are whatever the native runtime wrote there — native scratch data, not merely a
symlink; the claim is bounded to that. // ponytail: crash-leaked temp dirs are accepted; sweep externally if it
ever matters.

*Boundary, enforced vs residual (review P1-2):* the enforced set is — everything resident in `CODEX_HOME`
(config.toml, plugins, hook manifests/trust state, `AGENTS.md`/`AGENTS.override.md`, MCP definitions, cached
credentials beyond the symlink), user and project execpolicy `.rules`, and the already-scoped shell-startup
channels. Documented **residuals**, not claimed closed: instruction/skill/hook sources codex may discover from
`$HOME` or administrator/managed locations outside `CODEX_HOME` (the review cites `$HOME/.agents/skills`
discovery and managed hook layers). Whether any given residual is live in a specific codex release is exactly
what offline plumbing tests cannot prove; the implementation phase records a source→mechanism matrix (each known
0.162 source: closed by empty home / closed by flag / residual) in the plan, and behavioral verification of the
full boundary rides the next authorized live campaign. The spec's promise is the enforced set, no more.

**WB-3 Preflight gates.** `REQUIRED_CONTROLS` grows to `["--json", "--ephemeral", "--sandbox", "-",
"--ignore-user-config", "--ignore-rules", "--output-schema"]`, checked as exact whitespace tokens of
`codex exec --help` exactly as today (E3 discipline). A codex too old to carry the boundary flags fails doctor
and preflight before any spend; no version arithmetic is added — the presence of the controls is the floor. The
gate is a *capability* floor, not behavioral proof of isolation (review P2-7); the credential-source check of
WB-2 joins preflight as a second fail-closed refusal.

**WB-4 Receipt attestation.** The `worker` receipt object of an executed worker gains
`codexHomeManaged: true` — a literal marker that the run executed under the WB-1+WB-2 mechanism set (absence on
`not-started` matches the existing action-fields rule). It attests the enforced mechanisms, not universal
instruction isolation; it is the RCA §3B recommendation's minimal non-secret provenance for a receipt that
travels without its git context. No harness whitelist change rides with it.

### OC — explicit machine-output contract (opt-in)

**OC-1 CLI flag and staged bytes.** `turnhelm run` accepts `--output-schema <path>` (argument form matching
`--project`). The file is read once at the input boundary, before classification: regular file (no symlink,
matching the repo's `O_NOFOLLOW` read discipline), at most 64 KiB, valid UTF-8, and a JSON **object**. This
validates the *file envelope*, not its correctness as a Schema and not native enforcement (review P2-5); no
local schema validator is added. Rejection is a usage error: exit 2, fixed diagnostic, no receipt, no journal
write — the same pre-classification rejection class as an oversized task. The validated bytes (not the caller's
path) are staged as `output-schema.json` inside the per-run managed home and passed as
`--output-schema <managed-home path>` in the worker argv, so no reopen-race can substitute different bytes
between validation and worker consumption (review P2-4).

**OC-2 Semantics unchanged where they matter.** This is the RCA §6.4 "design and verify explicitly" branch, not
silent prefix extraction. The payload classifier, its four modes, and the receipt `payload` projection are
untouched, and `payload.mode` reports **framing only**: a final message that is valid JSON of the wrong shape
still classifies `strict` — native schema enforcement is the prevention layer, the classifier remains the
framing-observation layer, and consumers still validate acceptance themselves (RCA §3A stands). A schema run
whose final message carries trailing same-line prose stays visible as `unstructured`/`conflict`. Generic prose
tasks (no flag) are unaffected — `unstructured` stays a legal final state.

**OC-3 Consumers.** The validation harness may adopt per-case schema files in future rosters (RCA §6.5's matched
diagnostics); that adoption is out of scope here and needs its own authorization.

### FX — fixture authoring rule

**FX-1.** The custom-round/validation authoring guidance (README custom-round section and the skill's harness
paragraph) gains one normative rule, taken verbatim in substance from RCA §6.1: any task whose oracle depends on
an ordering, tie-break, or direction must state the direction explicitly and include one worked tied example;
the frozen oracles and sealed grades of past campaigns are never edited to match new wording.

### DC — boundary documentation

**DC-1.** README and the skill state the two product boundaries in one short paragraph each: (a) native
completion is delivery of a classified final message, not task verification — consumers gate on their own
contracts, as the harness already does; (b) the worker runs under a per-run managed `CODEX_HOME` (credential
symlink and staged schema only) with user config and execpolicy rules ignored — the enforced boundary and the
documented residuals are stated exactly as in WB-2, without claiming universal instruction isolation.

### Safety and performance statements

Safety: the worker's ambient configuration and policy surface shrinks to the task, the cwd project tree, and
turnhelm's explicit argv; credentials are reached by symlink, never duplicated or logged; boundary machinery
failure fails closed. Performance: one temp-dir create, one optional symlink, one staged file, one recursive
removal per run — no routing, deadline, retry, or settlement change (no latency number is claimed until
measured). The boundary removes a class of nondeterministic context variance (the 33-rollout hypothesis) that
retained evidence could not have debugged away.

## 4. Verification

Offline only; zero paid calls (the single §6 review call aside). New/adjusted tests:

1. `buildWorkerArgs` unit: exact argv vector includes `--ignore-user-config`, `--ignore-rules`, in position;
   with a schema, `--output-schema` points inside the managed home.
2. Worker-environment tests: `CODEX_HOME` points at a fresh per-run directory created under `tmpdir()`;
   the directory contains only the staged schema and (when the source exists) the `auth.json` symlink; an
   inherited `CODEX_HOME` value is never forwarded as the worker's `CODEX_HOME`; the directory is gone after
   completed, failed, cancelled, spawn-error, and mid-setup-failure settlements — and only after owned-shutdown
   discharge, never before `closed`.
3. Credential-symlink discipline: a write through the symlink lands in the target file (refresh write-through,
   no second copy); recursive removal unlinks the symlink and leaves the target untouched; `mkdtemp` failure
   (injected) yields the `spawn` failure class, never an inherited-home run; a missing credential source
   (no auth file, no `OPENAI_API_KEY`) refuses before classification with the fixed diagnostic and no journal
   append.
4. Schema staging TOCTOU: the caller's file is mutated/replaced/deleted/symlink-swapped after validation — the
   staged bytes the worker argv points at are still the validated ones (fake worker reads the staged file).
5. Receipt e2e: an executed worker's receipt carries `codexHomeManaged: true` with the exact expected key set;
   the `not-started` receipt shape is unchanged.
6. CLI parse: valid schema file → staged passthrough; missing file, symlink, oversized, non-UTF-8, non-object
   JSON → exit 2 with the fixed diagnostic, no journal append, no receipt.
7. Preflight: a help text lacking any one required control fails `inspectCodex` (fake-help fixtures, existing
   pattern); the current control list is pinned.
8. Payload framing regression: a final message of valid JSON with the wrong shape still classifies `strict`
   (OC-2); the payload suite (8/8) and the full existing suite pass; argv/env-pinning tests that asserted the
   pre-boundary vector are rewritten to the new truth (the authorized break), not deleted.
9. `pnpm test && pnpm build` green; `git diff --check` clean.

What these tests provably do **not** establish (review P2-7): effective isolation behavior of a real codex
build. If codex 0.162 exposes a no-inference introspection command (config/instruction dump), the plan adds a
behavioral check for the enforced set; otherwise behavioral verification of enforced set and residuals rides the
next authorized live campaign. No new paid campaign is authorized by this spec.

## 5. Non-goals

No automatic retry, escalation, confidence threshold, or profile-policy change (RCA §3C/§3D; a future matched
diagnostic needs its own authorization). No payload prefix extraction or any weakening of the four payload
modes; no local JSON-Schema validator. No harness (`custom-round`/`live-acceptance`) functional change or
whitelist extension. No `HOME` redirect (the worker's tooling legitimately needs caches and git config;
`ZDOTDIR` and `BASH_ENV`/`ENV` discipline already scope shell startup) and no attempt to close the HOME-rooted
residual channels without verified controls (approach D). No hook-trust bypass
(`--dangerously-bypass-hook-trust` is never passed). No placement of the managed home inside the project tree
(it would perturb harness tree snapshots). No edit to sealed grades, oracles, or closed authorities.

## 6. Review record — 2026-10-16 astra re-check

Routed through Turnhelm (Laya/direct selected `gpt-6-astra` / `high`, profile `frontier`, routing 788 ms; worker
completed in 318.8 s, `payload.mode: "strict"`; root `/Users/zhangxiao/.local/state/turnhelm/astra-review-20261016c`).
Verdict **PROBLEMS** → adjudicated against source; the spec above is the revised text.

| # | Pri | Finding (condensed) | Disposition |
| --- | --- | --- | --- |
| 1 | P1 | `mkdtemp(os.tmpdir() + …)` builds a broken prefix (`/tmpturnhelm-worker-`, or outside the per-user dir) | Accepted — WB-2 uses `mkdtemp(join(tmpdir(), …))`; §4 item 2 pins the parent |
| 2 | P1 | Emptying `CODEX_HOME` does not establish the promised task-plus-project-docs boundary: `$HOME/.agents/skills` discovery, managed/admin hook layers, `AGENTS.override.md`; `instructionIsolated: true` overstates | Partially accepted — the enforced mechanism set stands; the *claims* are narrowed to it: WB-2 gains an enforced-vs-residual boundary statement, approach D records the rejected "complete boundary" scope, WB-4 is renamed `codexHomeManaged` (mechanism attestation, not isolation), DC-1 rewritten to match; a source→mechanism matrix is an implementation-plan deliverable. Full behavioral proof is deferred to a live campaign (§4 closing note) — a boundary this session cannot verify offline is documented, not promised |
| 3 | P1 | Single-symlink auth contract unverified: keyring/auto credential modes, token refresh, concurrent workers | Partially accepted — WB-2 now declares supported modes (symlinked file, env key), adds a pre-spend credential-source refusal for everything else, documents refresh write-through and shared-file concurrency as *inherited* semantics, and pins write-through/no-copy offline; live refresh verification rides the next authorized campaign. Keyring-mode users lose silent operation by design (no back-compat) and get a fixed diagnostic instead |
| 4 | P2 | Schema validated at one path, reopened by the worker later — replacement/mutation TOCTOU | Accepted — OC-1 stages the validated bytes as `output-schema.json` inside the managed home and passes that path; §4 item 4 pins the swap cases |
| 5 | P2 | OC-2 wording wrong: valid JSON of wrong shape classifies `strict`, not `unstructured`; envelope validation ≠ schema validity | Accepted — OC-1/OC-2 rewritten: mode is framing-only, no local validator, §4 item 8 pins the strict-on-wrong-shape regression |
| 6 | P2 | Cleanup underspecified: races with native termination, symlink-following removal, crash remnants beyond a symlink | Accepted — WB-2 lifecycle: removal after settlement discharge on all paths, `rmSync`-unlinks-symlink pinned, remnant claim corrected to "whatever the native runtime wrote" |
| 7 | P2 | Argv/empty-dir/help-token tests prove plumbing, not isolation; the ≈1 ms claim is unmeasured | Partially accepted — §4 closing note states exactly what the offline tests do not establish, adds the conditional no-inference introspection check, defers behavioral verification to the next authorized campaign; latency number removed. The reviewer's own answer (d1–d3 "unknown here") confirms full behavioral verification is not achievable in this work |
