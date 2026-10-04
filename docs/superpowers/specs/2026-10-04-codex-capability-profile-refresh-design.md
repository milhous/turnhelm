# Codex capability-driven profile refresh

Date: 2026-10-04
Status: approved design, implementation not started

## Goal

Make Turnhelm's model/effort selection follow the current Codex capability
surface without trusting arbitrary classifier strings, adding network work to
normal task routing, or silently activating an unavailable model. Profile
updates must be atomic, auditable, reversible to the last known-good snapshot,
and safe for the active Codex provider.

## Evidence

- Codex CLI `0.160.0` is installed and the active provider is the custom
  `cliproxyapi` provider. `codex doctor --json` reports the provider and the
  configured default model, but does not expose a supported-model command.
- The local Codex model cache currently contains six entries: visible Luna,
  GPT-5.6 Terra, GPT-5.6 Luna, GPT-5.5, plus hidden reserve and auto-review
  entries. It does not contain Astra or GPT-6.1 Sol, so it is provider/cache
  evidence rather than a complete authority for this installation.
- The official model catalog identifies `gpt-6-astra`, `gpt-6.1-sol`, and
  `gpt-6-luna`. Astra and 6.1 Sol support `low`, `medium`, `high`, `xhigh`,
  and `max`; Luna additionally supports `none`:
  <https://developers.openai.com/api/docs/models>,
  <https://developers.openai.com/api/docs/guides/reasoning>.
- The current Turnhelm parser accepts arbitrary safe model/effort tokens and
  does not validate model-specific effort compatibility. `buildCodexArgs`
  passes the configured pair verbatim. Classifier output is already restricted
  to own configured profile IDs.

## Non-goals

- No model selection after `codex exec` starts.
- No model/effort cross-product generated at request time.
- No per-task network discovery, paid qualification call, confidence score,
  ensemble, bandit, catalog cache in the classifier, gateway, hook, or native
  subagent routing.
- No automatic mutation of `~/.config/turnhelm/config.json` or Codex user
  configuration.
- No activation of hidden, reserve, auto-review, legacy, or provider-unknown
  models merely because they appear in a cache.

## Recommended architecture

### 1. Capability manifest

Add a versioned, schema-validated capability manifest containing:

```ts
type ModelCapability = {
  model: string;
  family: "frontier" | "balanced" | "fast";
  supportedEfforts: string[];
  source: "official" | "codex-cache" | "qualified";
  visible: boolean;
  qualifiedAt?: string;
  codexVersion?: string;
  provider?: string;
};
```

The built-in official baseline is explicit and small:

```text
gpt-6-astra:   low, medium, high, xhigh, max       frontier
gpt-6.1-sol:   low, medium, high, xhigh, max       balanced
gpt-6-luna:    none, low, medium, high, xhigh, max fast
```

The local Codex cache is parsed read-only and can add a candidate only when it
is visible, `supported_in_api` is true, and its effort list is non-empty. Hidden
or system entries are discarded. Cache data cannot remove an official baseline
or activate a candidate by itself.

### 2. Qualification boundary

New or changed provider/model pairs enter the active set only after an explicit
qualification run. Qualification uses a fixed, non-user prompt, the selected
model and one supported effort, `read-only` sandbox, no repository task data,
no tools, a strict timeout, and scalar-only recording. It records exit status,
model, effort, Codex version, provider identity, latency, and a boolean marker;
it never stores prompts, responses, headers, credentials, or logs.

Qualification is never performed inside `route` or `codex`. A refresh command or
scheduled maintenance job may run it. If qualification fails, the candidate is
not activated and the previous snapshot remains usable.

### 3. Stable profile roles

Profiles are role IDs, not raw classifier-selected model names. The generated
active snapshot uses at most four roles:

```text
fast     -> gpt-6-luna / low
balanced -> gpt-6.1-sol / medium
deep     -> gpt-6.1-sol / high
frontier -> gpt-6-astra / xhigh
```

The role is activated only if its exact pair is qualified. If Astra is absent or
fails qualification, `frontier` is omitted; the classifier cannot return it.
If `deep` is unavailable, `balanced` is the only generated fallback. Existing
`direct` remains direct and continues using Codex's default model; it never
silently becomes Astra. The configured fallback profile must always point to an
active role.

### 4. Snapshot and refresh behavior

Store generated profiles in a separate, permission-restricted snapshot (not the
user's primary config) with schema version, generated time, source hashes,
Codex version/provider, qualification receipts, and active roles. Refresh writes
to a temporary file, validates it completely, fsyncs/renames atomically, and
keeps the prior snapshot if any step fails. Concurrent refreshes use a lock.

Expose:

```text
turnhelm models status   # scalar active roles, age, source, and qualification state
turnhelm models refresh  # refresh metadata and qualify new/changed pairs
```

Normal routing reads the last-known-good snapshot with no network and no model
probe. A stale snapshot remains usable until its configured expiry; it never
blocks a task on discovery. A missing snapshot has no active roles and fails
with an actionable refresh message rather than silently using unqualified
pairs. Refresh is explicit or scheduled outside the task critical path, so
latency and paid calls are bounded and observable. An automatic metadata refresh
may read the local Codex cache when stale, but it cannot activate a new pair
without a qualification receipt.

### 5. Validation and failure policy

- Every active pair must satisfy the model's exact effort list.
- Unknown model IDs, unsupported efforts, hidden entries, malformed snapshots,
  stale qualification receipts, and provider/version mismatches are rejected.
- A classifier may return only `direct` or an active role ID. Arbitrary model
  and effort values never reach Codex.
- A refresh failure leaves the old snapshot untouched. If no valid snapshot
  exists, routing fails before Codex starts with instructions to run the
  qualification refresh; no built-in pair is implicitly trusted for a provider.
- Existing secrets hygiene remains: classifier keys never reach Codex, and
  refresh receipts contain scalar metadata only.

## Testing strategy

- Unit-test the official effort matrix, hidden/cache filtering, role generation,
  schema/version checks, stale receipt rejection, fallback selection, and
  model-specific effort validation.
- Use a fake Codex executable and fake cache files for refresh/qualification
  tests; assert no real network, prompts, keys, or user config mutation.
- Test atomic-write failure and concurrent refresh locking.
- Test that generated role IDs become the only classifier choices and that
  `buildCodexArgs` receives the exact qualified pair.
- Run the existing full suite, source coverage thresholds, dependency audit,
  and a real qualification only as an explicitly authorized live gate.

## Security and performance invariants

- No per-invocation network or discovery latency.
- No unqualified or hidden model can enter the route chain.
- No user task text is sent during qualification.
- Snapshot writes are atomic and permission-restricted.
- Last-known-good state survives provider outage, malformed metadata, and
  interrupted refresh.
- Profile selection remains one immutable `(model, effort)` pair per Codex run.
