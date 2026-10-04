# Codex capability-driven profile refresh

Date: 2026-10-04
Status: implemented, independently reviewed, and verified offline (2026-10-04); no new live model qualification

## Goal

Automatically build Turnhelm's model/effort profiles from a small, validated
capability policy at config-load time. The normal routing path must remain local,
fast, deterministic, and free of network or paid discovery calls. Unknown,
hidden, or model-incompatible pairs must never reach `codex exec`.

## Evidence and scope correction

- Codex CLI `0.160.0` is installed with a custom `cliproxyapi` provider. The
  CLI has no stable `models` subcommand; `codex doctor --json` reports provider
  and config health but not a complete model catalog.
- The local `models_cache.json` is provider/cache evidence, not a public API
  contract. It currently lists six entries, including hidden reserve and
  auto-review entries, and does not list Astra or GPT-6.1 Sol even though the
  active installation can run GPT-6.1 Sol.
- The official current model matrix is small and explicit: `gpt-6-astra`,
  `gpt-6.1-sol`, and `gpt-6-luna`. Astra and 6.1 Sol support
  `low/medium/high/xhigh/max`; Luna additionally supports `none`:
  <https://developers.openai.com/api/docs/models>,
  <https://developers.openai.com/api/docs/guides/reasoning>.
- The existing parser accepts arbitrary safe model/effort tokens and
  `buildCodexArgs` passes them verbatim. The classifier already accepts only
  own configured profile IDs.

The previous proposal was too large: persistent snapshots, locks, fsync,
scheduled refresh jobs, qualification commands, and provider probes would add
new lifecycle and cost surfaces without a stable Codex catalog API. They are
removed from this design.

## Decision

Use one pure capability module and one in-memory profile materializer:

1. A checked-in official capability table defines the supported current model
   IDs and exact effort sets.
2. A defensive, read-only parser may inspect
   `$CODEX_HOME/models_cache.json` when present. It records only official IDs
   with `supported_in_api: true` and normalized effort metadata; hidden or empty
   entries remain non-active metadata only. The cache can confirm availability
   or add a visible candidate; it can never activate hidden entries, override
   the official effort matrix, or remove the official table.
3. The active Codex default model from `$CODEX_HOME/config.toml` is accepted as
   an additional availability signal only when it is one of the official IDs.
   This handles custom providers whose cache omits the configured default.
4. Profile roles are generated in memory on every `loadConfig` call. No network,
   subprocess, paid probe, snapshot write, lock, or user-config mutation occurs.
5. Explicit `profileMode: "explicit"` remains available for tests and controlled
   deployments. The shipped example opts into `profileMode: "auto"`; library
   callers that omit the field retain explicit mode and must supply profiles.

## Configuration contract

```ts
type ProfileMode = "auto" | "explicit";
type ProfileOverride = { description: string; model: string; effort: string };
type RawConfig = {
  backend: Backend;
  layaUrl: string;
  profileMode: ProfileMode;
  profiles?: Record<string, ProfileOverride>;
  fallbackProfile?: string;
  hostedJev: { enabled: boolean };
};
```

`parseRawConfig(value)` validates the file shape; `materializeConfig(raw,
capabilities)` produces the runtime `Config`. `parseConfig(value)` remains a
pure convenience for explicit-mode tests. In `explicit` mode, one to four
profiles are required and existing safe-token validation remains unchanged; a
provider may use a non-official but safe model ID in this deliberately explicit
mode. In
`auto` mode, `profiles` is optional and can override only the stable role IDs
`fast`, `balanced`, `deep`, and `frontier`; overrides require an official
model/effort pair and the model must be available in the local capability
signals. Arbitrary profile IDs are rejected in auto mode.

The generated role policy is deterministic:

```text
fast     -> gpt-6-luna / low
balanced -> gpt-6.1-sol / medium
deep     -> gpt-6.1-sol / high
frontier -> gpt-6-astra / xhigh
```

A role is emitted only when its model is available according to the official
matrix plus the local Codex signals. No cross-role substitution is performed:
if Astra is unavailable, `frontier` is omitted; if 6.1 Sol is unavailable,
`balanced` and `deep` are omitted. `fallbackProfile` defaults to `balanced`,
then `fast` when `balanced` is absent, and must name an emitted role when set.
`direct` remains direct and continues using the user's Codex default model; it
does not silently become Astra.

## Data flow and failure behavior

```text
loadConfig
  -> parse base fields and profileMode
  -> read official capability table
  -> best-effort read-only Codex cache/default model metadata
  -> generate or validate stable role profiles in memory
  -> validate fallbackProfile and return Config
route/codex
  -> classifier sees only emitted role IDs
  -> one immutable (model, effort) pair reaches codex exec
```

Cache absence, malformed cache JSON, unsupported cache schema, or unreadable
Codex config is non-fatal: the resolver uses official IDs only when explicitly
configured or when they are the active Codex default, otherwise omits the role.
Auto mode with no emitted role fails at config load with an actionable error;
it never silently falls back to an unverified model. No raw cache content,
paths, credentials, prompts, or responses are logged.
Model-access failures remain explicit child failures; they do not trigger an
unbounded model search or an automatic second model.

The launcher consumes one emitted profile and pins its model and effort in a
single `codex exec` invocation. `direct` emits no model or reasoning-effort
override. Auto classifier criteria contain only emitted role IDs; raw models
from omitted or unqualified roles never reach the classifier or route output.

## Security and performance invariants

- No per-invocation network, model probe, or paid request beyond the one
  classifier call already required by the route.
- Read-only cache/config inspection is size-bounded and defensive; malformed
  metadata cannot alter the route or crash the process.
- Hidden, reserve, auto-review, unknown, and effort-incompatible models never
  enter the classifier criteria or Codex argv.
- Profile selection remains one immutable `(model, effort)` pair per run.
- Classifier keys remain absent from the Codex child environment.
- No user config, Codex config, cache, or snapshot is modified.

## Testing strategy

- Unit-test the official matrix and every model-specific effort boundary.
- Unit-test visible/hidden/cache filtering, active-default recognition,
  malformed/oversized cache handling, auto role generation, explicit overrides,
  fallback selection, and no-role failure.
- Assert auto classifier criteria contain only emitted role IDs and
  `buildCodexArgs` receives exact generated pairs.
- Keep existing explicit test fixtures by setting `profileMode: "explicit"`.
- Add a loader test proving cache/config reads are read-only and do not emit
  secrets or raw metadata.
- Run the full offline suite, coverage threshold, dependency audit, and diff
  checks. Real model execution remains an explicitly separate live gate, not
  part of profile generation.
