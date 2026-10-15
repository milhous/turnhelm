# Explicit Jev Transport and Configuration v2

Date: 2026-10-14

Baseline: `e07bd54fcfc2fc0ffc1da865b1045e2c40c50e2d`

Status: The user approved the conversational design, then authorized an Astra review, specification updates, and an implementation plan. This revision incorporates verified findings. Product implementation and new live executions remain unapproved.

## 1. Intent and evidence

Optimize for long-term value, security, and performance without backward-compatibility branches. Production run, doctor --probe, and acceptance must honor one explicit Jev transport policy. Eliminate the working-diagnostic/unsupported-production split; do not manufacture PASS by changing historical grades.

Verified baseline:

- `src/cli.ts:196` → `src/route.ts:43` → `src/systemone.ts:73` uses a custom direct Agent with proxyEnv empty. The doctor CLI also injects the direct function at `src/cli.ts:118`.
- `src/config.ts:61–65` accepts only enabled for Jev, without a production proxy entry.
- The sealed campaign stopped after controlled Laya 503 → actual Jev 451 → no worker/CLI 1. Jev-only was unexecuted; 46 completed business cases passed their primary checks.
- A subsequent authorized explicit Clash-proxy classifier call returned HTTP 200/1860ms, selecting fast with zero workers. It proves that path returned a valid choice then, not production integration, actual exit, billing, or the earlier refusal policy.
- Direct and proxy diagnostics were five hours apart, not provider A/B. Separate loopback controls verify Agent behavior, not provider causation.
- On tested Node 24, Agent.destroy alone missed a pending CONNECT socket not yet pooled. Public createConnection return/callback socket ownership fixed the fixture; removing ownership produced the failing counterfactual.

Read-only diagnosis: `/private/tmp/turnhelm-partial-after-proxy-analysis-20261014-zIEJla/DIAGNOSIS.txt`, SHA-256 `85d8171603ce5daa10de282efe75e4243e0954db259fa276c7624a355bbd3c29`. This temporary evidence path is not a product dependency.

| Approach | Trade-off | Decision |
| --- | --- | --- |
| Explicit config, native Agent, request-scoped ownership, shared protocol | Auditable policy; Laya privacy; existing bounded decoder; no runtime dependency | Adopt |
| Inherit system/environment proxy | Hidden precedence/NO_PROXY bypass; unclear privacy boundaries | Reject |
| Custom CONNECT/general proxy framework | Unjustified protocol/dependency/maintenance surface | Reject |

No compatibility means refusing v1 and removing the old internal function alias, not overwriting files, migrating sealed records, or weakening authorization/TLS/stops.

## 2. Scope and invariants

Product scope: config/systemone/route/cli/doctor modules; small new `src/runtime.ts` for a shared floor. Init changes only where conflict diagnostics require it; preserve installation conflict handling.

Supporting scope: assets/config.json, engines, current configuration/init/transport/routing/CLI/doctor/journal fixtures and tests, live-acceptance/custom-round and their tests, live.integration and its existing argument tests, README/shared routing skill. New proxy tests: `test/proxy-transport.test.ts`.

Unchanged:

- Laya-first sequential routing, at most one attempt per eligible backend, no Jev after Laya success, shared deadline and three-quarter dual Laya budget.
- Six profiles/criteria/model-effort mapping/confidence semantics; worker output and initial environment boundaries.
- Hosted Jev requires enabled config, TURNHELM_ALLOW_HOSTED_JEV=1 and nonblank TYPESAFE_API_KEY. Proxy policy grants neither hosted nor write authority.
- 8192-byte response cap, strict UTF-8/JSON/choice, fixed failure projection, single receipt and best-effort journal.
- Frozen approval/caps, existing continuation/stops, exclusive claim/no replay/resume, sandbox contracts and historical grades.

Non-goals: discovery/port probes, Clash/node/TUN/system-proxy edits, remote proxies/SOCKS/PAC/authentication, product CA/TLS bypass, retries/redirects/direct fallback, pools/caches/daemons, policy/confidence tuning, key/account edits, migration, collector/campaign frameworks, automatic publication.

## 3. Configuration — JT-1

The sole `.turnhelm/config.json` becomes **version 2**. Other top-level fields and profiles retain their meaning. Require enabled and transport for Jev, including disabled Jev; parse/deep-freeze before network operations.

```ts
export type JevTransport =
  | Readonly<{ mode: "direct" }>
  | Readonly<{ mode: "http-connect"; proxyUrl: string }>;
```

Shipped Jev object:

```json
{ "enabled": false, "transport": { "mode": "direct" } }
```

Proxy example, not execution authority or permission to edit existing configuration:

```json
{
  "enabled": true,
  "transport": { "mode": "http-connect", "proxyUrl": "http://127.0.0.1:7890" }
}
```

Rules:

1. Require own properties. Direct has exactly mode; proxy exactly mode/proxyUrl. Reject missing/null/unknown modes, unknown fields and old Jev shape.
2. proxyUrl is a string <=256 characters, only `http://127.0.0.1:<port>` or `http://[::1]:<port>`, optionally one trailing slash.
3. Require explicit decimal port without leading zeroes, 1–65535. Validate literal syntax/range then URL semantics. Reject DNS/address aliases/other loopbacks, userinfo including empty-user @, whitespace/encoding, non-root paths/query/fragment/non-HTTP schemes.
4. Canonicalize without trailing slash, retaining explicit port including :80; URL.origin alone must not erase a valid port.
5. Never fill policy from environment. Missing transport is not direct; failure never changes mode. Fixed validation messages must not echo input or native URL errors.
6. Default Jev remains disabled/direct; Laya and profiles stay unchanged.

Export `parseJevTransport(value:unknown):JevTransport` as the single config/network validator; do not copy URL rules.

v1 run/probe refuse before classification; offline doctor reports config failure; init reports conflict with zero writes, retaining config/skill/AGENTS. Provide an actionable v2 example for owner-reviewed replacement, not automatic conversion/deletion. Preserve valid v2 config and installation idempotence.

## 4. Runtime — JT-2

API floor: **Node 24.5.0**, from [Agent proxyEnv documentation](https://nodejs.org/download/release/v24.11.0/docs/api/http.html#new-agentoptions). No old-runtime emulation or silently ignored proxy option. This is not a security-patch guarantee or proof every permitted runtime/platform was tested.

- runtime.ts shares one floor/pure predicate across CLI/doctor/default transport; engines/docs agree.
- CLI refuses before dispatch/task input/tools/writes: fixed diagnostic, exit 1, no classification receipt.
- Library doctor may return structured Node failure, but no probe; transport independently refuses before Agent/request creation.
- Isolated version-fact injection tests zero network/writes, not execution on old Node.
- Verify on actual Node 24.11.0 and CI Node 24; deployment should use maintained, patched runtimes, not merely the API floor.

## 5. Shared request boundary — JT-3

Keep bounded transport/protocol validation in systemone; no second decoder, generic client or registry.

```text
run -> routeTask ------------------+
doctor --probe -> runProbe --------+-> requestTaskChoice -> choiceRequest -> scoped Agent
classifier-only acceptance -------+                      -> bounded reply -> validateChoice
```

- Rename directChoiceRequest to choiceRequest, without legacy alias.
- RequestSpec gains required transport:JevTransport. Protocol builder uses direct for Laya and frozen Jev policy; it owns body, fixed Jev target and Origin Authorization.
- requestTaskChoice checks eligibility before default/injected requests, preventing direct callers from skipping enabled/hosted/key gates. Route/doctor retain scheduling/explanation checks, not different authorization rules.
- Route/probe pass optional trusted request seams to the sole protocol default. Remove doctor CLI's direct injection. Explicit eligible probe:true works without a test seam; offline doctor creates no network Agent/request.
- Seams are trusted fixture code, not user settings/security sandboxes. Production/live must not inject the temporary adapter.

Actual network boundary revalidates backend/target/transport: Laya direct HTTP numeric-loopback origin at /v1/systemone; Jev exactly `https://api.typesafe.ai/v1/systemone`. Reject URL userinfo/query/fragment and malformed transport/proxyUrl even through a type assertion. Use parseJevTransport once, not duplicated parsing. Fixed typed request failure, zero Agent/request/socket creation. Fixture remapping belongs only to isolated test instrumentation.

## 6. Security and lifecycle — JT-4

One scoped Agent per actual request; no globalAgent mutation:

| Policy | Explicit Agent settings |
| --- | --- |
| Laya direct | HTTP; keepAlive false; proxyEnv empty |
| Jev direct | HTTPS; keepAlive false; proxyEnv empty; rejectUnauthorized true |
| Jev http-connect | HTTPS; keepAlive false; proxyEnv only HTTPS_PROXY=proxyUrl, NO_PROXY empty; rejectUnauthorized true |

Never merge process.env or inherit case-variant proxy keys, environment-proxy flags or OS settings. Tests must activate global environment proxy, not merely set an inert variable.

Proxy receives only CONNECT to fixed Jev host:443. Origin auth/body are sent inside TLS after certificate/hostname verification, never in CONNECT headers. Invalid TLS rejects even with inherited TLS-disable settings; no product CA/verification bypass. Test CA is isolated to fixture children, never the real executor. Use [public Node HTTPS APIs](https://nodejs.org/download/release/v24.11.0/docs/api/https.html#httpsrequesturl-options-callback).

Ownership rules:

1. Pre-abort and invalid config/runtime/spec finish before Agent/request/socket creation.
2. Proxy Agent wraps public createConnection(options,callback), tracking/deduplicating returned pending and callback-established sockets and removing them on close. No private pools/custom CONNECT protocol.
3. At most one connection construction: no second construction/retry/direct fallback. Counts are not TCP/DNS/proxy-receipt/billing attestations.
4. Every success/error/cap/parse/synchronous-throw/abort/deadline uses one idempotent finish: detach signal, destroy request/response/tracked sockets/Agent, settle once.
5. Destroy sockets delivered after settlement immediately; cleanup-induced late error/close cannot re-settle or expose native messages.
6. Settlement records initiated destruction, not synchronous OS closure. Observe peer close, timely child exit and cleared owned resources separately. Fixture peers drain/respond to FIN to avoid false half-open leaks.
7. 407/dead port/disconnect/timeout fail closed; no config mutation. 3xx fails without following Location.

Keep existing ClassifierFailure kinds/code whitelist. Only target HTTPS IncomingMessage supplies origin httpStatus. Do not parse native/CONNECT errors into origin status, region/policy or rejecting-entity claims; retain null/unknown rather than invent stage taxonomy.

## 7. Bounded evidence — JT-5

TaskAttempt gains required transportMode:direct|http-connect, derived from frozen policy and retained for every outcome. Laya always direct. Receipt/journal reuse attempts; doctor describes policy without URL.

This is **application policy**, not actual Clash rule/node/exit/server receipt. A seam may return without networking; policy is not networking proof.

Export small pure projectAttemptTransports on the existing live-acceptance shared surface for both harnesses:

```ts
export type AttemptTransportEvidence =
  | readonly Readonly<{ backend: "laya" | "jev"; transportMode: "direct" | "http-connect" }>[]
  | "unverified";
```

- observed/case records gain attemptTransports from the unique CLI receipt routing.attempts; classifier-only uses its current routeTask attempts, not fabricated receipt/worker.
- At most two unique backends in a Laya-then-Jev subsequence. Missing/non-array/invalid/duplicate/oversized/backend-mode-invalid data becomes unverified; no plausible-prefix truncation. Ignore extra keys and rebuild only enum fields. Keep transportMode so sanitization is idempotent, without another adapter schema.
- Ordinary custom-round outcomes/stops do not gain a metadata gate. Unknown can accompany pass/failed/timeout; journal remains evidence-never-gate and continuation/order stays unchanged.
- Only section 10's two known specialized live cases add a verified policy check against frozen config, receipt order/count and existing usable journal. Unknown/mismatch prevents their transport PASS through existing verdict stop; no global gate/stop code/retry/authority.
- No persisted response/native error/headers/proxy URL/auth/extra task copies. Existing private oracleInput raw-content limits remain; never claim the whole ledger is content-free.

## 8. Performance

There is no second Jev call to amortize pooling. Keep scoped Agents, no keep-alive pool/cross-run TLS cache/idle connections. Bound state/cleanup, without unmeasured throughput/cost claims. CONNECT/TLS consume the existing monotonic deadline, with no grace/background preflight/budget increase. Offline doctor/prepare do not probe ports; future multi-request services are separate work.

## 9. Preparation and documentation

- Migrate current config/RequestSpec fixtures; do not change unrelated roster/template versions. withBackends/profile rebinding preserve Jev transport, never rebuild direct.
- Extend prepareAcceptance(suite,options?) with `options:{configPath?:string;caseId?:"dual-jev-write"}`. Default is shipped v2. Explicit config uses safe regular-file reading, <=65536 bytes, fatal UTF-8/JSON/parseProjectConfig before run-root creation. Wrap read/decode/parse failures in a fixed content-free diagnostic, never native JSON snippets or input bytes. Freeze final case config; execution never rereads the external input.
- Strict entry: `--prepare <suite> [--config <file>] [--case dual-jev-write]`. Selector only for dual/existing fallback ID. Reject unknown/duplicate/missing flags and prepare options on execute. No suite/arbitrary-filter/campaign framework; default full dual unchanged.
- Select fallback before creating consumers; derive caps from selected reservations under SUITE_CAPS/parser equality; no unused lead consumer.
- Bind 503 fixture by dual-jev-write identity, including singleton; laya-first check only for dual-laya-first identity, not position. Port conflict refuses before paid traffic, without repick/rewrite.
- Freeze final config/policy/runtime/HEAD/source/built baseline. Preserve dynamic live src/dist enumeration and custom-round recursive dist/src collection; test runtime module inclusion/drift rather than build a closure framework.
- Custom-round still scrubs hosted gate/key and is not the hosted executor. Config/manifest/roster/managed-template versions are independent; old artifacts retain claim/HEAD/baseline/config refusals without compatibility readers.
- README/shared skill cover v2/floor/privacy/TLS/authorization/shared probe/policy evidence/explicit refusal/prepare options. Do not rewrite historical specs. Narrowly supersede always-direct Jev, v1 and Node 24.0 decisions. Installed-skill conflicts still preserve owner files.

## 10. Acceptance and authority

TDD uses synthetic tasks/keys, owned loopback CONNECT/TLS and isolated test CA with network guards. No real Jev/Laya/Clash7890/original keys. Ownership-removal counterfactual must make pending-CONNECT cleanup fail.

| ID | Required evidence |
| --- | --- |
| JT-AC-01 | Both v2 modes; rejected v1/missing/extra/inherited/null/disabled-invalid fields and malformed proxy; IPv4/IPv6/:80/canonicalization/freeze |
| JT-AC-02 | Unsupported CLI/transport/probe zero-Agent/request/write refusal; floor/engines/docs consistency; honest actual-runtime evidence |
| JT-AC-03 | Shared spec/eligibility/default CLI/probe; wrong direct-boundary target/scheme/policy/userinfo/query/fragment/proxyUrl fixed typed failure with zero dialing; offline/gated zero requests |
| JT-AC-04 | Activated env/global proxy, case variants and NO_PROXY cannot change policy; local/direct bypass; one proxy CONNECT without Origin auth/body |
| JT-AC-05 | 407/dead/disconnect/pending/handshake/response stall/pre-abort/races/late sockets/synchronous throws settle once; no fallback/second construction; peer/process/resource cleanup and ownership-removal RED |
| JT-AC-06 | Certificate/hostname/TLS-disable-env failures before Origin auth; isolated trusted TLS; 401/451/3xx/204/205/8KiB overflow/compression/truncation/bad UTF-8/JSON/choice bounded, secret-free |
| JT-AC-07 | All outcome modes; receipt/journal/doctor agreement; bounded malformed/duplicate/extra-key/no-receipt/classifier-only projections; ordinary unknown modes never change custom-round outcomes/order; specialized live mismatch blocks transport PASS |
| JT-AC-08 | Non-overwriting/idempotent init; explicit config freeze/invalid-input zero traffic/no run-root; strict selector; singleton fallback caps={worker:1,laya:1,jev:1}; default dual preserved; identity fixture/lead checks; pre-spend drift/runtime baseline coverage |
| JT-AC-09 | Actual Node24 focused/full offline/typecheck; line/branch/function coverage >=80%; audit/diff/link/docs checks; minimal environments, no host-env dumps/new runtime dependency |
| JT-AC-10 | Independently authorized singleton Jev readonly and controlled-fallback Jev write via default CLI; policy/native requested argv tuple/completion/oracle/write contract reconcile; no seam/classifier-only substitution |

Stages:

1. Current spec/review/plan only: no product implementation/install/real classifier/worker/Clash/auth/history/commit/push changes.
2. Review plan and choose execution method before implementation/offline verification.
3. Separate preparation authority creates **two independent singleton manifests**, fresh SHA each: jev caps={worker:1,laya:0,jev:1}; dual fallback-only caps={worker:1,laya:1,jev:1}. Total classifiers <=3, workers <=2, hosted Jev <=2, controlled Laya failure <=1, real Laya inference 0. Freeze task/config/deadline/write/baseline. No live authority granted here.
4. Exact SHA and immediate hosted/write approval per execution. Manually reconcile readonly first; only exit0/full protocol/specialized evidence permits second. Any first failure/incompleteness closes second authority. No driver/retry/extra probe/worker/node switch/deadline increase. Singleton separation preserves ordinary oracle-failure continuation.
5. Link new results to historical PARTIAL without rewriting it. Band mismatches/natural xhigh-max/native policy/secret isolation/invoices/optimality stay separate.

Existing receipt-pair compares Turnhelm journal with config, not independent native evidence. Original observation source: `/private/tmp/turnhelm-routing-validation-20261014-e07bd54-bW0YDU/launcher/codex`, SHA-256 `c42ff0608a4790283dff2a80ef023bb76f81a403648cbeffd5223fd6883dda85`. It projects actual forwarded --model/model_reasoning_effort into canonical-root/model/effort records, associated by unique root with frozen task hash, receipt and journal. This proves requested client parameters, not provider-internal attestation.

Future live scope reviews/freezes a **pure observational** equivalent plus real executable identity, forwarding argv/stdin unchanged. Do not reuse old forced-login/auth-unset behavior, ledger or authority. No full argv/env/task logging or key-value reads; recording failure prevents unrecorded launch. This is separately approved temporary material, not a product collector. Without auditable native association, mark unverified and do not sign complete JT-AC-10.

## 11. Review disposition and risk

Reviewer: isolated read-only default subagent, gpt-6-astra/xhigh, 2026-10-14. Draft SHA-256 `51207796169a9ca2dd90cdec7bd8b73e12ae7b727c8d854ffc26804354ceb4a8`. Initial verdict **PROBLEMS: 2 P1 + 2 P2, no separate P3**. Parent verified source and accepted all:

| Finding | Correction |
| --- | --- |
| P1-1: prepare cannot receive proxy config (591–597; entry21–25) | Validated configPath/flags, final-config freeze, default preserved |
| P1-2: full dual exceeds scope; singleton loses fixture/lead checks; first failure may continue (694–705;1483–1490;1757–1758;1795–1805) | Existing fallback selector, reservation caps, identity handling, independent SHA/manual gate, native argv source |
| P2-3: global metadata stop conflicts with evidence-never-gate/continuation (custom708–709;1212–1245) | Pure evidence for ordinary rounds; specialized live gate only |
| P2-4: target/policy boundary lacks negative tests (systemone68–74;152–154) | Zero-dial boundary matrix and shared validator |

Retain strict v2/default-port handling, shared eligibility/default request, native Agent/Laya privacy/TLS, pending/late ownership, public APIs/floor and evidence honesty. Keep dynamic baseline discovery, not a closure framework. Parent self-review makes projection naming idempotent rather than adds an adapter.

The final English spec/plan review confirmed the four original corrections and found one additional P2 ownership omission: test/package.test.ts pins config v1, Node >=24.0.0 and old README/skill runtime copy (131–156). The parent verified this source and added packed version/engine/runtime-copy migration to Task 1, with remaining documentation assertions owned by Task 5. No architecture or authority expansion was required.

Static review is not implemented socket/TLS proof; actual runtime/platform regression remains necessary. Application direct cannot exclude OS/TUN/transparent gateways; proxy policy cannot attest Clash exit. The local proxy is a trusted intermediary and confidentiality depends on end-to-end TLS/system trust.

Original 451 details/current direct availability/actual exit/invoices remain unknown. No geographic causation or whole-architecture/all-paid-scenarios acceptance. Historical seals and old paid authority remain CLOSED.
