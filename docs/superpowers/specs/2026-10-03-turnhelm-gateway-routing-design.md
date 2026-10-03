# Turnhelm gateway routing design

Date: 2026-10-03
Status: Proposed; replaces the Hook-based Phase B design

## Decision

Turnhelm will route native Codex sessions at the provider request boundary,
not at the Codex tool boundary. A short-lived, loopback-only, pass-through
gateway is started by Turnhelm and the unmodified Codex CLI/TUI is launched as
its child process. The gateway rewrites only the model and reasoning-effort
fields for requests that explicitly use Turnhelm's routing sentinel. All other
requests are forwarded unchanged.

This is the only supported automatic-routing architecture. The previous
`PreToolUse Agent` design is retired: the current native subagent path emits a
hosted `collab_tool_call` and does not expose a stable local Hook event. No
Hook adapter, PTY interception, App Server client, MCP router, or Codex fork is
part of this design.

The gateway is an internal process boundary, not a public Turnhelm API. It is
allowed because it is the smallest boundary that can preserve the stock TUI
while changing the effective model. It must not write or mutate the user's
Codex configuration, authentication files, or provider credentials.

Backward compatibility is deliberately out of scope. The old Hook schema,
old Phase A execution contract, and old configuration shape are not supported
after the gateway design is implemented. Phase A may remain temporarily as a
development smoke harness, but it is not a product contract and is removed
after the gateway promotion gates pass.

The implementation is intentionally small: one launcher, one in-process
gateway, one typed-decision client, and one bounded in-memory route map. There
is no daemon, database, queue, dashboard, persistent cache, automatic retry,
or general provider abstraction.

## Goals

1. Keep the Codex CLI/TUI binary, rendering, permissions, sessions, and native
   subagent orchestration unchanged.
2. Route the root thread and native subagent threads to an existing Codex
   model/effort pair without creating, deleting, serializing, or reshaping
   subagent work.
3. Keep private coding prompts on local Laya by default and use hosted Jev
   only for explicitly permitted, bounded task text.
4. Make the common path low-latency: one local decision per new thread, no
   decision calls for tool continuations, compaction, titles, or background
   probes.
5. Fail open to the user's original Codex request for non-sentinel traffic;
   use the configured session baseline for a valid sentinel request whenever
   routing is unavailable, ambiguous, unsupported, or untrusted.
6. Make every effective rewrite testable from the outbound request and the
   provider response, rather than trusting the TUI's selected-model label.

## Non-goals

- Modifying, patching, forking, or dynamically loading Codex CLI/TUI code.
- Installing or relying on a Codex `PreToolUse`, `SubagentStart`, or other
  Hook to rewrite a spawn call.
- Adding a public HTTP API, MCP tool, skill, plugin, SDK, or custom TUI.
- Deciding whether Codex should delegate, how many agents it creates, which
  roles it chooses, task text, `fork_turns`, sandbox, approvals, or
  parallelism.
- Replacing the user's Codex provider with OpenRouter, Ollama, LiteLLM, or a
  second hosted model supplier.
- Routing every model call independently. Tool continuations remain on the
  selected thread route.
- Sending full Codex request bodies, transcripts, tool results, repository
  contents, system prompts, or credentials to Jev.
- Running Laya and Jev in parallel on the production hot path.
- Supporting the previous Hook adapter or migrating old configuration files.

## Hard constraints

- Node.js 22 or newer; use the existing TypeScript, built-in `fetch`, and
  standard-library HTTP/process primitives unless a dependency is required by
  a measured protocol need.
- The gateway binds only to `127.0.0.1` on an operating-system-selected
  ephemeral port and authenticates the child process with a random,
  per-session bearer token.
- Turnhelm must not write or mutate `~/.codex/config.toml`, profiles,
  `auth.json`, or generated model catalogs. Codex may perform its own normal
  runtime/session writes; those are not Turnhelm-managed configuration.
- Turnhelm never stores, prints, or makes routing decisions from Codex
  authentication tokens. The upstream authorization header is forwarded as an
  opaque value and is not included in logs.
- `TYPESAFE_API_KEY` is visible only to the gateway process. It is removed
  from the Codex child environment. Laya stays on loopback and may use
  `LAYA_API_KEY` only in the gateway environment.
- Only allowlisted model/effort pairs configured for the current Codex
  installation may be emitted. Arbitrary model strings returned by a decision
  backend are rejected.
- An explicit non-sentinel `model` or explicit reasoning effort is immutable.
  Native Codex precedence remains authoritative: explicit spawn settings win
  over defaults and inherited settings.
- Unknown Codex versions, request shapes, headers, or model/effort paths fail
  the startup protocol gate. Turnhelm then launches stock Codex without the
  routing sentinel. During a supported session, non-sentinel requests with
  unknown shapes are passed through unchanged; a malformed sentinel request is
  never forwarded upstream and is terminated locally. The gateway must never
  guess a field name.
- Raw prompts, request bodies, response bodies, authorization headers, Jev
  responses, and Laya responses are never logged or persisted.

## Runtime architecture

```text
turnhelm codex [codex arguments]
        │
        ├─ starts an ephemeral gateway on 127.0.0.1
        ├─ creates a per-session routing token
        └─ launches the stock codex binary with child-only provider env
                         │
                         ▼
             Codex CLI/TUI (unmodified)
                         │ OpenAI Responses-compatible request
                         ▼
           Turnhelm loopback pass-through gateway
             ├─ protocol/version gate
             ├─ explicit-setting and request-class gate
             ├─ local Laya typed-decisions (default)
             ├─ optional hosted Jev (explicitly enabled only)
             ├─ allowlisted model/effort map
             └─ opaque streaming pass-through to the existing provider
```

The launcher is the only user-facing entry point for automatic routing. A
plain `codex` invocation remains a normal, unrouted Codex session; it is not
modified or shadowed.

### Session startup

1. Validate the Turnhelm configuration and run the installed-Codex protocol
   preflight. The preflight must prove the child-only provider override, the
   virtual model sentinel, the upstream endpoint, the thread id, the request
   class, and the model/effort paths without writing Codex configuration.
2. If preflight fails, launch stock Codex without routing and do not start the
   gateway.
3. Select a free loopback port and generate a 256-bit random session token.
4. Start the gateway with a private environment containing routing keys and
   configuration. Do not create a key file.
5. Wait for the authenticated health check. If it fails, terminate the
   gateway and launch stock Codex without routing environment variables.
6. Launch stock Codex with a child-only provider base URL and the virtual
   model sentinel `turnhelm/auto`. The exact environment/profile mechanism is
   selected only after a real TUI smoke proves that no user Codex file is
   written and the existing login remains usable.
7. On Codex exit, stop the gateway, clear the child environment, and erase
   in-memory route state.

The launcher must preserve the original exit status and signal behavior of the
Codex process.

The preflight is a go/no-go gate, not a best-effort compatibility layer. If a
stock TUI cannot accept the sentinel and child-only provider override without
Turnhelm writing Codex configuration or credentials, this design is not
implemented for that Codex release. Do not add a Hook, PTY shim, catalog
patch, or second provider to work around the failure.

### Request classification boundary

The gateway recognizes only a pinned, tested Codex wire shape. Its normalized
input is:

```text
{
  model: string,
  effort?: string,
  threadId: string,
  requestClass: "human" | "subagent" | "continuation" | "auxiliary" | "unknown",
  taskText?: string
}
```

`threadId` must come from a Codex-provided thread identifier. A cache key,
transcript hash, or prompt text is not a substitute. `requestClass` may use
Codex headers/metadata only when that shape has been captured by the current
version's protocol probe. The launcher cannot enter routed mode unless those
fields and the sentinel path were proven by preflight.

The gateway routes only requests that satisfy all of the following:

- `model` is exactly `turnhelm/auto`;
- `requestClass` is `human` or `subagent`;
- the thread has no existing route, so this is its first routable request;
- task text is present, bounded, and contains no tool result or transcript;
- no explicit effort was supplied.

If the sentinel request carries an explicit effort, the gateway uses the
configured baseline model and preserves that explicit effort; it does not call
a classifier. This is the only supported sentinel request with an explicit
effort.

For a thread with an existing route, the gateway reuses the route and does not
call Jev or Laya again. Continuations, tool calls, compaction, titles,
background probes, and unknown request classes pass through without a new
decision. A request with any non-sentinel model is always passed through,
including explicit user or agent selections.

### Request rewriting

The gateway deep-copies the parsed request only long enough to change the
tested model field and the tested reasoning-effort field. It preserves every
other field, header, ordering-sensitive streaming option, tool definition,
conversation identifier, and request body value. If the effort path is not
the pinned path for the installed Codex version, the gateway does not rewrite
either field.

Responses and server-sent events are streamed byte-for-byte. The gateway does
not inject messages into the TUI and does not rewrite the provider's response
metadata.

## Routing policy

### Profile contract

The new configuration contains a fixed baseline and a small allowlist of
existing Codex model/effort pairs. A profile has exactly:

```text
id:        lowercase identifier
model:     existing Codex model id
effort:    effort supported by that model
description: bounded text used only by the decision backend
```

The route answer is one of `direct` or an allowlisted profile id. `direct`
means the configured session baseline, not an arbitrary backend model.

The configuration is versioned and strict. Unknown fields, old Phase A
backend fields, public Laya URLs, duplicate profile ids, unsupported effort
values, and model ids outside the configured allowlist are rejected at
startup. Secrets are environment-only:

- `TYPESAFE_API_KEY` for optional hosted Jev;
- `LAYA_API_KEY` for an authenticated local Laya server;
- `TURNHELM_ALLOW_HOSTED_JEV=1` for the explicit per-session hosted Jev opt-in;
- `TURNHELM_CONFIG` for an explicit configuration path used by tests or a
  controlled launcher.

### Local-first decision flow

1. A deterministic gate handles empty, oversized, continuation-like, and
   explicitly pinned requests without contacting a model.
2. Local Laya receives the bounded task text using the explicit
   `typed-decisions` checkpoint over the Jev-compatible `POST /v1/systemone`
   contract. Laya is the default and preferred production classifier.
3. Hosted Jev is disabled by default. It may be called only when the
   configuration enables it, `TURNHELM_ALLOW_HOSTED_JEV=1` is present for the
   session, and the bounded text is the current root-user task. Subagent task
   text, tool output, continuation text, file content, system prompts, and
   credentials are always local-only.
4. The backend answer is validated as a typed choice. Backend-specific
   confidence calibration is allowed, but Laya and Jev thresholds must never
   be copied between one another.
5. The selected profile is checked against the startup allowlist and the
   installed-model smoke result. Any mismatch becomes `direct`.

The hot path does not run an ensemble. Parallel Laya + Jev calls double
classifier latency and hosted-data exposure without being required for a
three-profile route. Ensemble evaluation belongs in an offline benchmark only.

### Hosted-data policy

There is no heuristic content scrubber in the hot path. Such a scrubber would
create a false sense of privacy and add an unbounded maintenance surface.
Hosted Jev is an explicit, per-session opt-in for root-user task text only.
The launcher must display that opt-in in its diagnostic line, and the gateway
must enforce the source and size boundary above. Users who cannot permit any
task text to leave the machine leave hosted Jev disabled; local Laya remains
the complete routing path.

### Thread stickiness

Route state is kept only in memory, keyed by a cryptographically hashed
thread id. Each entry has a bounded TTL and the cache has a fixed maximum
size. The cache stores only profile id, model, effort, creation time, and
protocol version; it never stores task text or request bodies.

A subagent receives an independent route when Codex presents an independent
thread id and the request uses `turnhelm/auto`. This preserves native
subagent orchestration while allowing a search or review child to use a
different existing model. An explicit child model/effort bypasses the router.

## Failure and safety behavior

The router is fail-open with respect to ordinary Codex execution:

- Laya timeout, Jev timeout, HTTP failure, malformed answer, unknown profile,
  hosted-data opt-out, or cache failure: use the configured baseline for a
  valid sentinel request, and forward non-sentinel requests unchanged.
- A malformed sentinel request is a protocol fault. It is closed locally
  without retry or field guessing; the launcher must have prevented this by
  passing the protocol gate before starting a routed TUI session.
- Gateway health failure before TUI startup: run stock Codex without routing.
- Gateway crash during a session: surface one local diagnostic and terminate
  the routed Codex child with the gateway's failure status. Do not restart the
  child against another model or silently fall back mid-turn; the user may
  rerun plain Codex.
- Upstream authorization or provider errors: forward the provider error;
  Turnhelm does not change credentials or permissions.
- Port collision, token mismatch, malformed JSON, oversized body, or invalid
  streaming framing: fail before or at the affected request and leave the
  user's normal Codex invocation available.

Fail-open means no automatic model downgrade beyond the configured session
baseline, no forced escalation, no new subagent, and no change to the approval
or sandbox policy.

## Security requirements

1. Loopback bind and a random session token are mandatory; listening on
   wildcard or LAN addresses is a startup error.
2. The gateway must set restrictive process environment handling and must not
   inherit `TYPESAFE_API_KEY` or `LAYA_API_KEY` into Codex.
3. Authorization headers are opaque and excluded from errors, metrics,
   crash reports, and child output.
4. Request logging is disabled by default. Optional diagnostics contain only
   protocol version, request class, hashed thread id, route source, model,
   effort, status, and latency.
5. No prompt, transcript, tool output, response body, or classifier response
   may be written to disk. Temporary files are not needed by the gateway.
6. Hosted Jev calls use a separate bounded root-task payload builder;
   forwarding code, a subagent task, or a complete Codex body to Jev is a test
   failure.
7. The gateway validates all model and effort strings against configuration
   before rewriting. Decision output is data, never a shell command or URL.
8. The launcher must clean up the gateway on normal exit, signals, startup
   failure, and child crash.

## Performance requirements

- No-route pass-through overhead: p95 <= 10 ms on the local machine,
  excluding upstream latency.
- Warm local Laya routing: p95 <= 100 ms for a bounded task.
- Hosted Jev routing: p95 <= 750 ms when explicitly enabled; it must never be
  invoked for continuations, subagent tasks, or sessions without the explicit
  opt-in.
- At most one classifier request per thread lifetime unless the thread is
  explicitly restarted.
- The route cache is bounded to 1,024 entries and a six-hour TTL; eviction is
  silent and causes a new bounded decision on the next eligible request.
- Streaming response latency and chunk boundaries must not be buffered by the
  gateway beyond the minimum required to parse the request headers/body.
- The gateway must not load Codex transcripts or repository files into memory.

## Configuration contract

The only supported configuration is a strict versioned object at
`$HOME/.config/turnhelm/config.json`, or the path supplied by
`TURNHELM_CONFIG`:

```json
{
  "version": 2,
  "baseline": { "model": "gpt-6.1-sol", "effort": "high" },
  "profiles": {
    "fast": {
      "description": "Small, localized, low-risk work",
      "model": "gpt-6-luna",
      "effort": "low"
    },
    "deep": {
      "description": "Complex debugging, review, or security analysis",
      "model": "gpt-6.1-sol",
      "effort": "high"
    }
  },
  "layaUrl": "http://127.0.0.1:8765",
  "maxTaskChars": 2000,
  "hostedJev": { "enabled": false }
}
```

The exact model ids must be replaced with ids confirmed by the current Codex
installation before a live smoke. The example is not a claim that every
account exposes the same catalog. A configuration with an unavailable model
is rejected rather than silently substituted.

## Verification and promotion gates

### Static and unit gate

Test the new gateway without a fake Jev/Laya integration claim:

- strict configuration and allowlist validation;
- sentinel and explicit-model bypass;
- request-class and thread-id extraction;
- exact preservation of non-routing request fields;
- model/effort rewrite only on the pinned path;
- route stickiness and bounded eviction;
- hosted-Jev source/opt-in boundary cases;
- no-secret/no-raw-payload diagnostics;
- fail-open behavior for every protocol and backend error.

### Live backend gate

Run at least 24 real labelled calls against local Laya and 24 against Jev,
using English and Chinese task text. Record p50/p95 latency and choices only;
do not store prompts, responses, headers, or keys. The gate fails if either
service is unavailable or if any labelled choice is wrong. No fixture may be
substituted for a real backend.

### Protocol gate

Against the installed Codex version, capture only sanitized key/type shapes,
field names, headers, and version identifiers. Verify:

- the child-only provider override works;
- the stock TUI remains usable;
- the sentinel reaches the gateway;
- the upstream endpoint is derived without reading or writing Codex auth;
- the current thread id and request class are stable;
- the model and effort paths can be rewritten without touching other fields;
- streaming responses remain valid;
- no Codex file or credential changes occur.

If any item fails, the gateway is not promoted and the stock Codex path is
used. Do not guess a new schema or add a compatibility branch for an
unsupported release.

### Native orchestration gate

Compare an unrouted baseline and routed sessions for:

1. no delegation;
2. one native subagent;
3. two explicitly parallel subagents;
4. an explicit child model/effort;
5. a custom agent role;
6. classifier unavailable;
7. a tool continuation after a routed response.

The child count, roles, task text, ordering, parallelism, permissions,
sandbox, parent behavior, and continuation behavior must be identical. Only
the effective model/effort of eligible sentinel requests may differ.

### Promotion and retirement

Promote the gateway only after the protocol, live backend, security,
performance, and orchestration gates pass on the current Codex release. Do
not install a Hook or change a user-level Codex file.

After promotion, remove the old Phase A execution path, Hook entrypoint,
legacy config parser, and related tests. Keep only the shared typed-decision
client, the gateway, the launcher, the diagnostic route policy, and the
verification suite required by this design. This is a deliberate replacement,
not a compatibility migration.

## Source notes

- Codex Hooks and local-tool coverage: <https://learn.chatgpt.com/docs/hooks>
- Native subagent model/effort precedence:
  <https://learn.chatgpt.com/docs/agent-configuration/subagents>
- Pass-through Codex routing and session-sticky routing:
  <https://github.com/dirien/jev-router>
- Session-scoped loopback proxy and subagent thread routing:
  <https://github.com/flaviusapop/jev-router>
- Per-call Jev model/effort routing through a Codex Router fork:
  <https://github.com/0xNatoshi/jev-codex-router>
- Local Laya Jev-compatible server and typed-decisions checkpoint:
  <https://github.com/NandhaKishorM/laya>
- Laya/Jev ensemble example and its non-production status:
  <https://github.com/rawwerks/one-system>
