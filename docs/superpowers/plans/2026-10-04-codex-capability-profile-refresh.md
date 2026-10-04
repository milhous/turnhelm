# Codex Capability Profile Refresh Implementation Plan

Status: complete and independently reviewed offline (2026-10-04). Final implementation `fac0d6d`; hermetic tests 216/216; coverage 99.40%/94.05%/100%; audit zero vulnerabilities; no live model qualification.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate safe `fast`/`balanced`/`deep`/`frontier` profiles from the official Codex model-effort matrix and read-only local Codex capability signals without adding runtime network or paid discovery work.

**Architecture:** `src/models.ts` owns the small official capability table and defensive read-only parsing of `$CODEX_HOME` metadata. `src/config.ts` parses raw configuration and materializes auto profiles in memory; explicit mode remains a pure test/deployment escape hatch. Existing routing and launcher code consume the resulting active profile map without new classifier or subprocess behavior.

**Tech Stack:** TypeScript, Node.js built-in test runner, JSON/TOML-safe scalar parsing, existing Codex CLI configuration, Git.

## Global Constraints

- The official baseline is exactly `gpt-6-astra` (`low`, `medium`, `high`, `xhigh`, `max`), `gpt-6.1-sol` (`low`, `medium`, `high`, `xhigh`, `max`), and `gpt-6-luna` (`none`, `low`, `medium`, `high`, `xhigh`, `max`).
- Normal routing performs no network request, subprocess model probe, paid qualification call, snapshot write, lock, or user-config mutation beyond the existing classifier request.
- `$CODEX_HOME/models_cache.json` and `$CODEX_HOME/config.toml` are read-only advisory signals; malformed, oversized, missing, hidden, or unknown metadata is ignored safely.
- `profileMode: "auto"` emits only stable IDs `fast`, `balanced`, `deep`, and `frontier`; `profileMode: "explicit"` preserves safe-token profile fixtures and controlled deployments.
- `profileMode` defaults to `"explicit"` for library/test callers; the shipped example opts into `"auto"`.
- Auto role mapping is fixed: `fast -> gpt-6-luna/low`, `balanced -> gpt-6.1-sol/medium`, `deep -> gpt-6.1-sol/high`, `frontier -> gpt-6-astra/xhigh`.
- A role is emitted only when its model is in the official matrix and available from local cache or the active Codex default model. No cross-role substitution is performed.
- Hidden, reserve, auto-review, legacy, unknown, and effort-incompatible models never reach classifier criteria or Codex argv.
- No raw cache/config content, paths, credentials, prompts, responses, or logs are emitted by capability resolution.
- Existing hosted-Jev gates, classifier key scrubbing, route fallback behavior, and one-shot Codex launcher semantics remain unchanged.
- Unit tests use temporary files and dummy credentials only; no real classifier or Codex call is made by the offline suite.
- Run `npm test`, `npm run test:coverage`, `npm audit --audit-level=high`, and `git diff --check` before the final commit. Coverage thresholds remain at least 80% lines, branches, and functions.
- No new dependency, daemon, background job, persistent snapshot, refresh CLI, or network catalog client is added.

---

### Task 1: Add official capability matrix and safe Codex metadata parsing

**Files:**
- Create: `src/models.ts`
- Create: `test/models.test.ts`

**Interfaces:**
- Produces `ModelCapability`, `CodexSignals`, `OFFICIAL_MODEL_CAPABILITIES`, `readCodexSignals(env?: NodeJS.ProcessEnv): CodexSignals`, and `isSupportedEffort(model: string, effort: string): boolean`.
- `CodexSignals` contains only scalar model IDs and effort arrays: `{ defaultModel?: string; cached: Record<string, { visible: boolean; supportedInApi: boolean; efforts: string[] }> }`.

- [x] **Step 1: Write the failing capability and parser tests.**

  Create temporary `CODEX_HOME` directories per test. Add these exact cases:

  ```ts
  test("official matrix exposes exact model-specific efforts", () => {
    assert.deepEqual(OFFICIAL_MODEL_CAPABILITIES["gpt-6-astra"].efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(OFFICIAL_MODEL_CAPABILITIES["gpt-6.1-sol"].efforts, ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(OFFICIAL_MODEL_CAPABILITIES["gpt-6-luna"].efforts, ["none", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(isSupportedEffort("gpt-6-astra", "none"), false);
    assert.equal(isSupportedEffort("gpt-6-luna", "none"), true);
  });

  test("reads only visible API-backed cache models and default model", async () => {
    // write a bounded fake models_cache.json and config.toml under CODEX_HOME
    // containing visible Luna, hidden reserve, and default gpt-6.1-sol
    // assert hidden entries are retained only as non-active metadata
    // and no secret/path/raw JSON field is returned
  });

  test("ignores absent, oversized, malformed, and schema-incompatible metadata", () => {
    // each case returns empty safe signals and never throws
  });
  ```

  Use a real temporary directory and `t.after` cleanup. Do not use the actual
  `$HOME/.codex` directory. Run:

  ```bash
  npm run build && node --test dist/test/models.test.js
  ```

  Expected: RED because the new module/functions do not yet exist. Record the
  failing command in the task report before editing production code.

- [x] **Step 2: Implement the minimal pure matrix and defensive reader.**

  Add the exact official table and a 1 MiB maximum file size. Read only:
  - `models_cache.json.models[]` entries with scalar `slug`, `visibility`,
    `supported_in_api`, and `supported_reasoning_levels[].effort` fields;
  - a single anchored `model = "..."` assignment from `config.toml`.

  Normalize efforts through the official matrix, discard unknown IDs and
  unsupported values, and return empty signals on all filesystem/JSON errors.
  Do not shell out to Codex, fetch the network, log metadata, or expose file
  contents. Keep the module dependency-free and side-effect-free apart from
  bounded reads.

- [x] **Step 3: Run focused GREEN and commit.**

  Run the same focused command and verify all capability/parser tests pass with
  clean output. Then run `git diff --check` and commit:

  ```bash
  git add src/models.ts test/models.test.ts
  git commit -m "feat(models): add codex capability matrix reader"
  ```

### Task 2: Materialize auto profiles during config loading

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`, `test/route.test.ts`, `test/systemone.test.ts`
- Modify: `examples/config.json`

**Interfaces:**
- Consumes `readCodexSignals` and `isSupportedEffort` from Task 1.
- Produces `ProfileMode = "auto" | "explicit"`, `RawConfig`, `parseRawConfig(value: unknown): RawConfig`, `materializeConfig(raw: RawConfig, signals: CodexSignals): Config`, and existing `parseConfig/loadConfig` behavior.

- [x] **Step 1: Add RED tests for raw config and role generation.**

  Extend fixtures with `profileMode: "explicit"` and add these tests before
  changing production code:

  ```ts
  test("auto mode emits only available stable roles", () => {
    const config = parseConfig({
      backend: "auto",
      profileMode: "auto",
      layaUrl: "http://127.0.0.1:8765",
      hostedJev: { enabled: false },
      profiles: {},
      fallbackProfile: undefined
    }, {
      defaultModel: "gpt-6.1-sol",
      cached: {
        "gpt-6-luna": { visible: true, supportedInApi: true, efforts: ["low", "medium", "high", "xhigh", "max"] }
      }
    });
    assert.deepEqual(Object.keys(config.profiles), ["fast", "balanced", "deep"]);
    assert.equal(config.profiles.fast.model, "gpt-6-luna");
    assert.equal(config.profiles.deep.effort, "high");
    assert.equal(config.fallbackProfile, "balanced");
  });

  test("auto mode rejects an override with an unsupported effort", () => {
    assert.throws(() => parseConfig({
      backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
      hostedJev: { enabled: false },
      profiles: { frontier: { description: "x", model: "gpt-6-astra", effort: "none" } }
    }, { defaultModel: "gpt-6-astra", cached: {} }), /effort/);
  });

  test("auto mode has no silent role when no official model is available", () => {
    assert.throws(() => parseConfig({
      backend: "auto", profileMode: "auto", layaUrl: "http://127.0.0.1:8765",
      hostedJev: { enabled: false }, profiles: {}
    }, { cached: {} }), /no available profiles/);
  });
  ```

  Add assertions that generated profile descriptions are the classifier
  criteria, explicit mode still accepts synthetic test models, and arbitrary
  profile IDs are rejected in auto mode. Run focused config/route/systemone
  tests and capture the intended RED failures.

- [x] **Step 2: Implement raw parsing and in-memory materialization.**

  Keep `parseRawConfig` responsible for common object/backend/loopback,
  `profileMode`, hosted-Jev, and optional raw profile shape checks. Keep
  `materializeConfig` responsible for the official effort matrix, availability
  signals, role generation, override validation, and fallback selection.
  `parseConfig(value, signals?)` calls both with empty signals by default for
  explicit-mode tests; `loadConfig` calls both with `readCodexSignals()`.

  Auto generation must follow this exact order:

  ```ts
  const roles = {
    fast: ["gpt-6-luna", "low"],
    balanced: ["gpt-6.1-sol", "medium"],
    deep: ["gpt-6.1-sol", "high"],
    frontier: ["gpt-6-astra", "xhigh"]
  } as const;
  ```

  Emit a role only when its model is official and either appears as visible,
  API-backed cache metadata or equals the active Codex default. Apply a valid
  role override after availability validation. Use fallback `balanced`, then
  `fast`; throw before routing if no role remains. Return a null-prototype
  profile map so inherited classifier choices remain impossible.

- [x] **Step 3: Run GREEN and commit.**

  Run:

  ```bash
  npm run build && node --test dist/test/config.test.js dist/test/route.test.js dist/test/systemone.test.js
  env -u TYPESAFE_API_KEY -u LAYA_API_KEY -u TURNHELM_ALLOW_HOSTED_JEV npm test
  npm audit --audit-level=high
  git diff --check
  ```

  Update `examples/config.json` to `profileMode: "auto"` with no legacy
  `gpt-6-sol` profile. Commit:

  ```bash
  git add src/config.ts test/config.test.ts test/route.test.ts test/systemone.test.ts examples/config.json
  git commit -m "feat(config): materialize codex capability profiles"
  ```

### Task 3: Finish launcher contracts, documentation, and coverage

**Files:**
- Modify: `test/codex.test.ts`, `test/cli.test.ts`, `test/live.integration.ts`
- Modify: `README.md`, `docs/validation/2026-10-03-jev-laya-phase-a.md`
- Modify: `docs/superpowers/specs/2026-10-03-jev-laya-phase-a-routing-design.md`
- Modify: this plan and the capability-refresh spec status after verification

**Interfaces:**
- Consumes the materialized `Config` and stable role IDs from Task 2.
- Produces documented auto-profile behavior and complete offline verification.

- [x] **Step 1: Add RED launcher and live-harness contract tests.**

  Add assertions that `buildCodexArgs` emits exact model/effort pairs for
  `gpt-6-astra/xhigh`, `gpt-6.1-sol/high`, and `gpt-6-luna/low`, while direct
  routes emit no model override. Add a CLI characterization test that an auto
  config's route JSON exposes only emitted role IDs and no raw model from an
  unqualified profile. Keep live tests opt-in and real-service-only; do not
  call live services in this RED stage.

  Run:

  ```bash
  npm run build && node --test dist/test/codex.test.js dist/test/cli.test.js
  ```

- [x] **Step 2: Update documentation without adding runtime machinery.**

  Document `profileMode: "auto"`, the four role mappings, official
  model-specific effort limits, cache/default-model read-only signals, the
  no-network/no-probe runtime rule, and the fail-closed no-role behavior. Mark
  legacy `gpt-6-sol` profile examples as removed from the auto policy. Keep
  existing live evidence dated; do not claim a new live model qualification.

- [x] **Step 3: Run full GREEN gates and commit.**

  Run all of the following with classifier credentials unset:

  ```bash
  npm test
  npm run test:coverage
  npm audit --audit-level=high
  git diff --check
  ```

  Expected: all existing and new tests pass, every production module remains
  above 80% lines/branches/functions, and audit reports zero vulnerabilities.
  Commit with:

  ```bash
  git add test/codex.test.ts test/cli.test.ts test/live.integration.ts README.md docs/validation/2026-10-03-jev-laya-phase-a.md docs/superpowers/specs/2026-10-03-jev-laya-phase-a-routing-design.md docs/superpowers/specs/2026-10-04-codex-capability-profile-refresh-design.md docs/superpowers/plans/2026-10-04-codex-capability-profile-refresh.md
  git commit -m "feat(router): add capability-driven codex profiles"
  ```

## Completion criteria

- `profileMode: "auto"` generates only official, locally available model/effort pairs.
- The classifier sees only active stable role IDs; hidden/cache-only unknown models are excluded.
- `direct` remains unmodified and no mid-run model switching is introduced.
- No runtime network discovery, paid probe, persistent snapshot, daemon, or user-config mutation exists.
- `npm test`, `npm run test:coverage`, `npm audit --audit-level=high`, and `git diff --check` pass.
- README, current Phase A spec, validation doc, and this spec/plan describe the final contract accurately.
