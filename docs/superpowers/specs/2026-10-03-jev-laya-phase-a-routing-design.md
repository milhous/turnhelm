# Turnhelm Phase A Jev/Laya model-effort routing design

Date: 2026-10-03
Status: implemented and validated (2026-10-03)

Dated evidence: the authorized 2026-10-03 real-service smoke passed 24/24 cases
for each of Laya and Jev. Final offline boundary hardening passed 189/189 tests
on exact Node 22.8.0 (bundled npm 10.8.2), Node 24.21.0, and Node 26.5.0,
with source coverage of 99.25% lines, 93.06% branches, and 100% functions.
See [validation evidence](../../validation/2026-10-03-jev-laya-phase-a.md),
which also preserves the earlier 168-test hardening receipt.
The hardening verification made no new live calls.

## Decision

Turnhelm keeps one supported integration boundary: the existing Phase A
`turnhelm route` and `turnhelm codex` commands. Each invocation makes one typed
decision before `codex exec` starts, then passes one validated `(model, effort)`
profile to the stock Codex child. The selected pair is immutable for that
invocation.

The MVP has three explicit classifier modes:

- `laya`: call the configured loopback Laya service once;
- `jev`: call hosted TypeSafe Jev once;
- `auto`: call Laya once, then call Jev once only when Laya fails and hosted
  fallback is explicitly enabled.

`auto` is local-first for latency and data minimization. It is not an ensemble:
there is no parallel Jev call, confidence adjudication, bandit update, live
model-catalog discovery, or mid-session switching. A malformed/unknown answer,
service failure, timeout, missing opt-in, or unavailable fallback selects the
configured baseline profile. No arbitrary classifier output reaches Codex.

The previously proposed Gateway and Hook paths are not part of this design.
They were removed because the installed Codex protocol was not admitted.
Native Codex subagent routing remains unsupported.

## Why this is the smallest safe design

The repository already has the right stable boundary: a pure profile allowlist,
a typed-decision request, a one-shot Codex launcher, and a fallback profile.
The additional behavior needed is only backend composition and an explicit
hosted-Jev opt-in. A live Codex catalog, tier compiler, receipt store, online
learning loop, risk classifier, or request gateway would create new failure
surfaces without improving the proven Phase A contract.

Model and effort remain one pair, not two independent classifier choices. The
configuration is the source of truth for allowed pairs in this MVP; Codex is
responsible for rejecting a model that the account cannot use. A future catalog
adapter may be added only after a separate measured requirement.

## Evidence and limits

TypeSafe's `/v1/systemone` API accepts a state, a model, and typed questions and
returns typed answers: <https://api.typesafe.ai/redoc>.

Laya exposes the same `POST /v1/systemone` shape and typed `choice`, `score`,
and `noul` decisions: <https://github.com/NandhaKishorM/laya>.

Laya is substantially faster locally, but its public documentation warns that
untuned checkpoints are not a general zero-shot replacement for Jev and that
shipped confidence can be overconfident. Therefore Turnhelm does not use a
confidence threshold in the MVP; it accepts only a validated choice or falls
back: <https://github.com/flyhof-labs/laya-jev>.

The closest session-safe prior art binds one model and effort for a session and
keeps adaptive effort experimental: <https://github.com/hyspacex/jev-router>.
Projects that support Jev or Laya as a message classifier remain experimental or
deployment-specific, including
<https://github.com/obetomuniz/auto-mode-for-paseo> and
<https://github.com/suenot/codex-jev-router>.

Research such as RouteLLM, Route-to-Reason, Ares, and PILOT supports learned or
budget-aware routing, but those approaches require deployment-specific training,
feedback, or calibration and are intentionally future work here:
<https://arxiv.org/abs/2406.18665>,
<https://arxiv.org/abs/2505.19435>,
<https://arxiv.org/abs/2603.07915>,
<https://arxiv.org/abs/2508.21141>.

Reasoning effort values are model-dependent. The MVP validates configured safe
tokens but does not pretend that a universal effort enum exists:
<https://developers.openai.com/api/docs/guides/reasoning>.

## Configuration contract

The existing profile shape remains:

```ts
type Profile = {
  description: string;
  model: string;
  effort: string;
};
```

The version-1 configuration is extended minimally:

```ts
type Config = {
  backend: "laya" | "jev" | "auto";
  layaUrl: string;
  profiles: Record<string, Profile>;
  fallbackProfile?: string;
  hostedJev: { enabled: boolean };
};
```

`hostedJev.enabled` is necessary but not sufficient. Hosted Jev is callable
only when `TURNHELM_ALLOW_HOSTED_JEV=1` and `TYPESAFE_API_KEY` is present.
`LAYA_API_KEY` remains optional and is used only for the loopback request.

Every profile model and effort is validated with the existing safe-token rules.
Profile IDs are the only choices exposed to Jev/Laya, plus `direct`. Descriptions
are bounded and contain no credentials or routing secrets.

## Decision flow

```text
turnhelm route/codex task
  -> reject empty input
  -> apply existing continuation/length fallback policy
  -> build one typed choice over direct + profile IDs
  -> backend = laya: call Laya once
  -> backend = jev: call Jev once
  -> backend = auto: Laya once, then opted-in Jev once on Laya failure
  -> accept direct or an allowlisted profile
  -> otherwise select fallbackProfile or fail before Codex starts
  -> for codex: spawn stock codex exec with that profile's model/effort
```

The original task is passed to Codex unchanged. Turnhelm never parses a
transcript, repository, tool output, or hidden reasoning to classify it. There
are no retries beyond the single Laya-to-Jev fallback transition.

Hosted Jev receives only the bounded Phase A task text, and only after explicit
configuration and environment opt-in. Subagent text, tool arguments, and
continuation data are local-only.

The limit is exactly 2000 JavaScript UTF-16 code units of the original task.
`resolvePhaseARoute` uses local fallback for longer or continuation-only input;
strict `classifyTask` and `chooseProfile` calls reject it before any backend
work. Invalid or blank tasks also fail before fetch. The request builder is
private, and every classifier request rejects redirects with `redirect: "error"`.

## Non-goals

- No loopback provider Gateway, HTTP interception, PTY shim, App Server client,
  Hook, MCP rewrite, or Codex protocol dependency.
- No routing of native Codex subagents or hosted collaboration items.
- No model or effort switching after Codex starts.
- No automatic delegation, parallelism, role, sandbox, approval, or permission
  changes.
- No classifier confidence threshold, online bandit, live catalog cache, tier
  compiler, risk model, circuit breaker, receipt database, or ensemble in the
  MVP.
- No fake Jev/Laya service in live validation.

## Security and failure behavior

- `TYPESAFE_API_KEY`, `LAYA_API_KEY`, and `TURNHELM_CONFIG` are removed from the
  Codex child environment.
- Raw prompts, tool arguments, backend output, credentials, and response bodies
  are never logged or written to files.
- Laya is restricted to HTTP loopback URLs.
- Hosted Jev is opt-in and never receives a subagent task or tool data.
- Non-sentinel behavior is irrelevant because no provider gateway exists.
- A valid `direct` answer runs Codex without a model override; a valid profile
  answer must be an own configured ID and uses only its configured model and effort.
- Responses are streamed into a fixed 65536-byte buffer. Oversized declared
  Content-Length is rejected before reading; actual byte counts are enforced
  even without an accurate header. Invalid UTF-8/JSON, missing bodies, and read
  failures are generic, with cancellation/release cleanup on decoding failure.
- Codex waits for child/stdio closure, handles stdin errors before writing,
  preserves nonzero child codes, and returns failure if input transfer fails
  despite a zero child exit. Spawn failures reject generically. No execution
  timeout, retry, or model-switch policy is added.
- Backend timeout, transport error, malformed JSON, unknown profile, missing
  key, or disabled hosted fallback uses `fallbackProfile` when configured;
  otherwise the command exits before Codex starts.
- The fallback is not retried through another model or provider.

## Validation gate

Fast tests must cover:

1. strict config parsing for `auto` and `hostedJev`;
2. direct and allowlisted profile choices;
3. Laya success in `laya` mode;
4. Jev success in `jev` mode;
5. `auto` using Laya without contacting Jev;
6. `auto` using Jev only after an opted-in Laya failure;
7. no Jev call when hosted fallback is disabled or the environment opt-in is
   absent;
8. malformed/unknown answers selecting the configured fallback;
9. classifier keys absent from the Codex child environment; and
10. unchanged model/effort argv construction for the selected profile.

The live command remains opt-in and real-service-only. It may run the existing
labelled cases against Laya and Jev, but it must report source, selected profile,
and latency only. It must never substitute fixtures or claim that the small
labelled set proves general routing quality.

A future calibration project may add held-out task data and confidence
calibration. That work is not required to ship this deterministic MVP and must
have its own spec and acceptance gate.

## Migration state

Commit `d0a52c1` removed the unadmitted Gateway design, execution plan, and
protocol report. The approved Phase A plan is now implemented: explicit auto
mode, hosted opt-in gates, the one-shot launcher, and the dated real-service
smoke are complete. Subsequent boundary hardening shares local-only input
policy, rejects redirects, and retains hermetic source-coverage and audit gates
in pinned Node 24 CI. These changes affect only the Phase A decision boundary;
they do not change Codex user configuration or native orchestration. Remote
publication and integration remain controller-owned gates.
