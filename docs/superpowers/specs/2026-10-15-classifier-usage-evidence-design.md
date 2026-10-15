# Post-Campaign Classifier Usage Evidence

Date: 2026-10-15

Baseline: `ec6bcb48d0e381ef0bf1651c1d718e3fc821e578`

Status: The user authorized this spec cycle from the sealed 2026-10-15 validation campaign, an Astra re-review, spec updates, and an execution plan. Product implementation and new live executions remain unapproved.

## 1. Intent and evidence

Optimize for long-term value, security, and performance without backward-compatibility branches. The sealed campaign verdict is COMPLETE-WITH-FAILURES (`/Users/zhangxiao/.local/state/turnhelm/validation-20261015-ec6bcb4-QMcv4C/REPORT.md`, report SHA-256 sealed in `final-seal.json`). This spec converts the campaign's findings into exactly one product change plus a recorded decision not to change everything else.

Verified baseline:

- `src/systemone.ts:287–312` — `validateChoice` reads Laya's `envelope.usage` only to enforce `truncated === false` and `state_tokens_dropped === 0`, then discards the content. Laya replies demonstrably carry more: the installed Laya 0.3.22 agent builds `usage` with `input_tokens`, `output_tokens` (always 0), `state_tokens`, `state_tokens_dropped`, `truncated`, and optional `truncated_questions`/`options`/`windows` (`.live-laya-venv/.../laya/agent.py`, usage construction).
- `src/cli.ts:215` — the receipt hardcodes `classifierUsage: "unreported"`; `src/journal.ts:29–34` journals the selection without any usage fact. Both campaign reports list "classifier usage unreported" as an open cost-evidence limitation.
- `src/codex-events.ts:44–79` — the worker side already has the house idiom for this exact problem: `usageSnapshot`, a per-field non-negative-safe-integer whitelist that freezes its result and degrades to absent. The classifier side has no equivalent.
- The lone engineering failure, `07-version-fixed-balanced`, was a **final-output-protocol** failure: worker completed (exit 0), `payload.mode: "unstructured"` where the task mandated exact whole JSON; the secondary code contract passed. Turnhelm transported the message faithfully and the oracle failed it — the system behaved as designed. The paired natural run of the same task on the **identical** `gpt-6.1-sol`/`medium` tuple passed, so the format non-compliance is stochastic model behavior, not a tier-caused defect.
- Routing evidence: 24/38 natural business band mismatches with **all 38 cases passing** at or below their expected band; 3/6 profiles never naturally selected; of the 8 paired controls, 5 were naturally routed to `fast` and all 5 passed, while the fixed-balanced controls passed 7/8 — their sole failure being the output-protocol case above; calibration-dev mismatched in the opposite direction (frontier selected where fast/balanced was declared). The report itself records bands as "policy hypotheses, not proven optimality ground truth" — neither optimality nor band noise is established.

| Approach | Trade-off | Decision |
| --- | --- | --- |
| Project a bounded Laya usage whitelist into choice/receipt/journal | Closes a recurring cost-evidence gap with the existing worker idiom; zero extra requests | Adopt |
| Output repair / retry / regrade on unstructured payloads | Masks model non-compliance, spends money, contradicts the frozen no-repair campaign policy; receipt `payload.mode` already is the evidence | Reject |
| Force worker output format from the transport | The supported Codex CLI (>=0.160) exposes no response-format forcing over the final message, and the task must reach the worker verbatim | Reject |
| Retune bands/criteria or collapse unused profiles from this data | Bidirectional mismatches (dev over-selects, business under-selects) with a 100% natural pass rate are insufficient evidence to retune: the report establishes neither optimality nor band noise; 38 synthetic cases would overfit | Reject |
| Confidence gating or escalation | No calibration or causal evidence exists: the temperature warning's impact on six-profile inference is unproven, and the single very-low-confidence datapoint (0.0395) is the failed format case whose code contract passed — no clean signal either way; gating adds a second policy on unproven semantics | Reject |

Non-goals (unchanged open findings, none of them new in this campaign): the JT-AC-10 observational launcher (separately authorized future work under the archived transport spec), actual proxy-exit attestation, host filesystem secret isolation beyond the existing child-environment boundary, Laya-side checkpoint temperature handling (not configurable through `laya.serve`), off-machine backup of evidence, and any new live classification or worker execution.

## 2. Scope and invariants

Product scope: `src/systemone.ts`, `src/route.ts`, `src/cli.ts`, `src/journal.ts`, plus their tests. Documentation scope: `README.md:350` and both byte-identical routing-skill copies (`.claude/skills/turnhelm-routing/SKILL.md` and the packaged `.agents/skills/turnhelm-routing/SKILL.md`, both line 237) wherever they state `classifierUsage` is `"unreported"`. No harness behavior change: `live-acceptance`/`custom-round` do not read `classifierUsage`, and their receipt readers keep ignoring it.

Unchanged:

- Six profiles, criteria, model/effort mapping, Laya-first sequential routing, budgets, eligibility gates, and transport policy.
- The truncation guard stays a hard failure (`truncated` must be exactly `false`, `state_tokens_dropped` exactly `0`): it guards answer completeness, not accounting.
- Worker output boundary, payload emission contract, no-retry semantics, receipt shape otherwise, best-effort journaling with non-regular-path skip.
- No new configuration, environment variables, keys, origins, dependencies, or requests.

## 3. Classifier usage projection — CU-1

`TaskChoice` gains an optional frozen `usage`; `TaskDecision` gains an optional `classifierUsage`; the receipt's `classifierUsage` becomes the projection when present and stays the literal `"unreported"` otherwise; the journal gains `classifierUsage` on selection only, mirroring how `confidence` is appended.

Projection rules:

1. Laya only, after the existing truncation guards pass. Project exactly `input_tokens` and `state_tokens`, keeping Laya's field names verbatim — token-size facts with calibration value (task size versus profile and outcome); everything else in the envelope is discarded.
2. Per-field validation in the `usageSnapshot` idiom: own-property, `Number.isSafeInteger`, `>= 0`, frozen. A missing or invalid field is omitted; an empty result projects nothing. Usage is evidence and never a gate: no run, route, or probe outcome changes on any usage shape.
3. Jev never projects: the hosted envelope's usage shape is unverified, so it stays `"unreported"` rather than guessing billing fields.
4. `doctor --probe` may surface the projection through the existing choice result but gains no new output contract.

## 4. Security and performance

The projection carries bounded non-negative integers only — no task text, native objects, headers, or error strings — so it adds nothing the journal does not already safely hold. Parsing is local to the already-received reply; there are no extra requests, no state, and no timing change.

## 5. Acceptance and authority

TDD with synthetic replies; no real Laya/Jev/worker execution is authorized by this spec.

| ID | Required evidence |
| --- | --- |
| CU-AC-01 | Valid Laya usage projects exactly `{input_tokens, state_tokens}`; missing/unsafe/negative/non-integer/foreign fields omit individually; empty result stays `"unreported"`; result frozen |
| CU-AC-02 | Truncation guard unchanged and still fatal; usage projection only on guard-passing replies; no projection affects any routing/worker/receipt outcome |
| CU-AC-03 | Receipt and journal agree on selection; journal omits the field for failed/cancelled routing; `"unreported"` preserved on Jev and absent-usage paths |
| CU-AC-04 | README and shared routing skill updated; no harness fixture or reader change required; full offline suite, typecheck, audit, and diff checks pass |

Stages: (1) this spec, Astra review, updated spec, and plan only; (2) implementation and offline verification under a separately chosen execution method; (3) any future live confirmation rides the next already-authorized validation cycle — no new live authority is granted here.

## 6. Review disposition

Reviewer: isolated read-only Codex child, gpt-6-astra/xhigh, 2026-10-15, session `01a13ef8-1af7-78e0-a32f-f868e05577de`. Draft SHA-256 `7d59865b9d859b4024e917d2e1d81d243c2ae3fc2117943d4f4489cc5cccac7d`. Initial verdict **PROBLEMS: 2 P2 + 1 P3**. The parent re-verified every finding against `report.json` and the source and accepted all:

| Finding | Correction |
| --- | --- |
| P2-1: confidence-gating rejection called the 0.0395 selection passed and overstated the temperature warning | 0.0395 is the failed format case's route (its code contract passed); REPORT.md:60 says the clamp's inference impact is unproven — rationale rewritten to no-calibration/no-causal-evidence |
| P2-2: "7/8 controls naturally routed fast" conflated control pass count with natural routing (report.json pairs: 5/8 natural fast) | Corrected to 5/8 natural fast all passing, controls 7/8 with the sole failure being the output-protocol case; "hypothesis noise" replaced with insufficient-evidence phrasing |
| P3: journal citation 35–41 vs actual selection serialization at 29–34 | Citation corrected |

Parent-added (post-review, self-verified): the paired 07-version runs prove same-tuple nondeterminism (natural pass vs control fail on identical sol/medium), now in §1; the packaged `.agents` skill copy is named in §2. The reviewer noted as unverifiable from the listed inputs: installed-Laya semantics, harness-wide consumer claims, and the absence of Codex output-format controls — the first two were parent-verified against the installed venv and repo grep, the third holds for the supported Codex CLI (>=0.160) and is now version-anchored. No architecture change was requested; the one-work-item scope survived review.
