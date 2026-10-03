# Turnhelm Phase A Jev/Laya model-effort routing design

Date: 2026-10-03
Status: proposed, research-backed; implementation not started

## Decision summary

Turnhelm should keep Phase A as the supported integration boundary and remove the
unadmitted Gateway/Hook path. The stable unit of routing is a **session binding**:
one validated `(model, effort)` pair is selected before Codex starts and remains
fixed for that invocation. Turnhelm must not proxy or rewrite Codex inference
requests, mutate an in-flight turn, or attempt to route native subagent
collaboration items.

The decision layer should use a conditional local-first policy rather than an
always-parallel ensemble:

1. A compact, bounded task description is evaluated by local Laya only when the
   configured checkpoint has passed a held-out calibration gate for the active
   decision workflow.
2. Laya may return a pair tier or abstain. An abstention, out-of-domain result,
   unhealthy local service, high-risk task, or calibration failure invokes
   hosted Jev when explicitly enabled.
3. Jev may adjudicate the compact task and the sanitized Laya judgment, then
   chooses one allowlisted pair tier.
4. If the selected decision backend is unavailable or malformed, Turnhelm uses
   the explicit configured baseline pair. It never invents a model or effort.

Until a task-specific Laya checkpoint and calibration set are accepted, the
production default is Jev-first with Laya in shadow evaluation. This avoids
mistaking Laya's fast inference for validated routing accuracy.

## Evidence and scope

TypeSafe's `/v1/systemone` API accepts a state, a model, and typed questions and
returns typed answers; it is a decision API, not a text-generation model:
<https://api.typesafe.ai/redoc>.

Laya exposes the same `POST /v1/systemone` shape and supports typed `choice`,
`score`, and `noul` decisions. Its checkpoint router can select by language or
explicit task: <https://github.com/NandhaKishorM/laya>.

The Laya/TypeSafe-compatible project documents useful but binding caveats: the
untuned checkpoints are not a general zero-shot replacement for Jev, shipped
confidence can be overconfident, and temperature calibration must be fitted on
held-out data before probabilities are used:
<https://github.com/flyhof-labs/laya-jev>.

The closest session-safe implementation is `hyspacex/jev-router`: Jev chooses
from a YAML model pool, the router binds a model and effort for a session, and
adaptive effort is explicitly experimental and disabled by default:
<https://github.com/hyspacex/jev-router>.

Other relevant references are useful as patterns, not as production evidence:
`auto-mode-for-paseo` supports Jev or local Laya but labels the plugin
experimental; `suenot/codex-jev-router` makes Laya an optional decider; and
`jevons` demonstrates local/Laya/cloud failover with timeouts and a circuit
breaker. None proves a universally optimal model-effort policy for Turnhelm's
Codex workload.

Academic work supports treating model and reasoning policy as a joint routing
choice. RouteLLM provides threshold-calibrated strong/weak routing
(<https://arxiv.org/abs/2406.18665>); Route-to-Reason jointly routes models and
reasoning strategies under a token budget
(<https://arxiv.org/abs/2505.19435>); Ares routes reasoning effort per agent
step using interaction history (<https://arxiv.org/abs/2603.07915>); and PILOT
frames adaptive routing as a contextual bandit with explicit budget control
(<https://arxiv.org/abs/2508.21141>). These methods require deployment-specific
data and are not copied into the first implementation.

OpenAI's reasoning controls are model-dependent, so effort values must be
validated against the live Codex model catalog rather than treated as a global
enum: <https://developers.openai.com/api/docs/guides/reasoning>.

## Goals

- Select a valid model and reasoning effort before a Phase A Codex invocation.
- Keep the chosen pair stable for the whole invocation.
- Prefer local inference for privacy and latency only after local quality is
  demonstrated for the relevant workflow.
- Use Jev as an explicit quality fallback/adjudicator, not as an unbounded
  free-form planner.
- Preserve existing Codex authentication, permissions, sandbox, orchestration,
  and user configuration.
- Make every routing decision replayable from safe scalar evidence without
  storing prompts, tool arguments, credentials, or model responses.
- Retain a deterministic baseline when both decision services are unavailable.

## Non-goals

- No loopback provider gateway, PTY shim, HTTP interception, App Server client,
  Hook, MCP rewrite, or Codex protocol dependency.
- No routing of native Codex subagents or hosted collaboration items.
- No mid-turn model or effort switching.
- No automatic delegation, parallelism, role, sandbox, approval, or permission
  changes.
- No promise that a classifier confidence score is a probability of task
  success without calibration evidence.
- No concurrent Jev+Laya calls on every request; that is an optional research
  arm, not the production hot path.
- No online bandit updates until an evaluated feedback and rollback mechanism
  exists.

## Routing contract

### Catalog and pair registry

At startup, Turnhelm obtains a non-secret model catalog through the supported
Codex inspection path or an explicit test fixture. Each candidate is represented
as a pair, never as independent model and effort choices:

```ts
type ModelEffortPair = {
  id: string;
  model: string;
  effort?: string;
  capabilities: readonly string[];
  riskClass: "normal" | "sensitive";
};
```

Only pairs present in the validated registry can be returned by Jev or Laya.
An effort is omitted when the selected model has no reasoning control. An
unknown model, unsupported effort, or stale catalog entry is rejected before
Codex starts.

The classifier sees short stable tier IDs (for example `fast`, `balanced`,
`deep`, and `safe`), not arbitrary provider model names. Turnhelm maps the
selected tier to the current catalog pair and records the mapping in the
launch receipt.

### Typed decision questions

The first implementation uses a small fixed question set:

- `tier`: a `choice` over the configured tier IDs;
- `in_domain`: a `noul` gate used only after Laya has a held-out calibration
  record for this workflow;
- `needs_safe_pair`: a `noul` gate for privacy or consequence-sensitive work.

The task state is bounded, normalized text supplied by the caller. Turnhelm
never parses a transcript, repository, tool output, or hidden reasoning to
construct routing state.

### Backend policy

`decisionPolicy` has three explicit modes:

- `jev-first`: production default until Laya passes the local acceptance gate;
- `calibrated-laya-first`: local Laya may decide, with Jev on abstention or
  policy escalation;
- `jev-only` or `laya-only`: diagnostics and controlled experiments only.

The local service is bound to loopback and has a short timeout. Infrastructure
failures are distinguished from invalid decisions. Invalid or out-of-domain
answers do not silently become a cheaper pair.

Hosted Jev is disabled unless configuration and an explicit environment opt-in
allow it. When enabled, only the bounded Phase A task description and the
minimal typed Laya judgment may leave the machine. Subagent text and tool data
remain local-only.

### Session binding

Phase A resolves the pair before spawning Codex:

```text
turnhelm codex task
  -> normalize and bound task text
  -> resolve model catalog and pair registry
  -> Laya or Jev typed decision
  -> validate pair and create safe receipt
  -> spawn stock Codex with one-run model/effort settings
```

The original task is passed unchanged to Codex. The route decision is not
inserted into the task text. A classifier failure selects the configured
baseline pair and marks the receipt as `baseline`; it does not retry another
provider or modify the task.

## Calibration and evaluation gate

Laya cannot become the production first hop from latency alone. Before enabling
`calibrated-laya-first`, Turnhelm must have a versioned, held-out dataset of
representative tasks with the following labels:

- correct tier or acceptable pair set;
- sensitivity/risk class;
- language and task family;
- actual success outcome from the selected model-effort pair;
- latency and usage scalars.

The gate must report per-tier precision/recall, abstention rate, calibration
error, false-cheap rate, false-deep rate, p50/p95 decision latency, and total
routing cost. A task family fails the gate if its local router routes a
high-risk task to a non-safe pair or if its calibration is not better than the
configured deterministic baseline.

The evaluation compares at least four arms:

1. fixed baseline pair;
2. deterministic local policy;
3. Jev-only typed routing;
4. calibrated Laya-first with Jev fallback.

A shadow arm may collect hypothetical Laya choices without changing execution.
Raw prompts and model responses are not committed to the repository; fixtures
must be synthetic or sanitized and access-controlled.

## Security and operations

- `TYPESAFE_API_KEY` and `LAYA_API_KEY` remain process-environment secrets and
  never enter Codex's child environment, config files, receipts, or logs.
- Receipts contain only route source, tier ID, model, effort, catalog revision,
  request class, latency, status, and fallback reason.
- Local Laya health uses a bounded timeout and a circuit breaker so a dead local
  process does not add its timeout to every task.
- Hosted Jev is never called concurrently with Laya in the normal path.
- A decision backend cannot grant permissions, change sandbox, enable network
  access, or create agents.
- Catalog refresh failure is explicit; the last known pair is not silently
  reused beyond its configured revision/TTL.

## Migration from the restored baseline

The Gateway design, execution plan, and blocked protocol report are removed by
commit `d0a52c1`. The existing Phase A classifier and Codex launcher remain the
only supported implementation. The next implementation plan, after this spec
is reviewed, should be limited to the Phase A decision-policy, pair-registry,
calibration, and safe-receipt changes described above.

No implementation is authorized by this document until the user reviews the
spec and approves the follow-up plan.
