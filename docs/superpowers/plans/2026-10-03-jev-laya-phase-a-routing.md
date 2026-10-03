# Turnhelm Jev/Laya Phase A Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing Phase A launcher with an explicit `auto` mode that calls local Laya once and optionally falls back to hosted Jev, while selecting only configured model-effort profiles.

**Architecture:** Keep the current one-shot boundary: `turnhelm route`/`turnhelm codex` classifies a bounded task before starting stock `codex exec`. A typed choice returns `direct` or one allowlisted profile. `auto` performs one Laya request and, only after an opted-in Laya failure, one Jev request; all other failures use the existing fallback profile. No gateway, Hook, catalog cache, mid-session switch, or native subagent routing is added.

**Tech Stack:** Node.js 22+, TypeScript, built-in `fetch`, `node:test`, real TypeSafe Jev, real local `laya[serve]`.

## Global Constraints

- Preserve Phase A only; do not add a loopback provider gateway, PTY shim, App Server client, Hook, MCP rewrite, or Codex protocol dependency.
- Select one configured `(model, effort)` profile before `codex exec`; never choose model and effort independently.
- `backend = "auto"` calls Laya once, then Jev at most once only when `hostedJev.enabled === true` and `TURNHELM_ALLOW_HOSTED_JEV === "1"`.
- Do not use classifier confidence, live model-catalog discovery, tier compilation, ensemble adjudication, online bandits, circuit breakers, receipt databases, or mid-session switching in this plan.
- Hosted Jev receives only bounded Phase A task text and is never called for subagent/tool data.
- Keep Laya URLs on `127.0.0.1` or `::1`; never log task text, backend output, credentials, or response bodies.
- Remove `TYPESAFE_API_KEY`, `LAYA_API_KEY`, and `TURNHELM_CONFIG` from the Codex child environment.
- A malformed/unknown backend answer never reaches Codex; use `fallbackProfile` when configured, otherwise fail before Codex starts.
- Do not add a runtime dependency. Run `git diff --check`, `npm test`, and `npm audit --audit-level=high` before the final commit.

---

### Task 1: Define the minimal auto-mode configuration and retire stale Hook entrypoints

**Files:**
- Modify: `src/config.ts`
- Modify: `test/config.test.ts`
- Modify: `examples/config.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-10-02-turnhelm-routing-design.md`
- Modify: `docs/superpowers/plans/2026-10-02-turnhelm-routing.md`

**Interfaces:**
- `Backend = "laya" | "jev" | "auto"`.
- `Config = { backend: Backend; layaUrl: string; profiles: Record<string, Profile>; fallbackProfile?: string; hostedJev: { enabled: boolean } }`.
- `parseConfig(value: unknown): Config` keeps the current profile and loopback validation.
- A missing `hostedJev` property parses as `{ enabled: false }` so existing Phase A config files remain safe and do not silently enable hosted traffic.

- [ ] **Step 1: Replace config tests with the red contract.**

  Extend the existing `base` fixture with `hostedJev: { enabled: false }` and
  add these exact assertions:

  ```ts
  test("accepts auto mode with hosted Jev disabled", () => {
    const config = parseConfig({ ...base, backend: "auto" });
    assert.equal(config.backend, "auto");
    assert.equal(config.hostedJev.enabled, false);
  });

  test("defaults hosted Jev to disabled", () => {
    const config = parseConfig(base);
    assert.equal(config.hostedJev.enabled, false);
  });

  test("rejects malformed hostedJev", () => {
    assert.throws(() => parseConfig({ ...base, hostedJev: { enabled: "yes" } }), /hostedJev/);
  });
  ```

  Keep the existing loopback, fallback, profile ID, description, model, and
  effort assertions.

- [ ] **Step 2: Run the focused red test.**

  Run:

  ```bash
  npm test -- --test-name-pattern='auto mode|hosted Jev|loopback|unknown fallback'
  ```

  Expected: failure because `auto` is not an accepted backend and
  `hostedJev` is not parsed.

- [ ] **Step 3: Implement the smallest parser change.**

  In `src/config.ts`, change only the backend union and returned shape. Parse
  `hostedJev` as follows before returning:

  ```ts
  const hostedJev = value.hostedJev === undefined
    ? { enabled: false }
    : (() => {
        if (!isObject(value.hostedJev) || typeof value.hostedJev.enabled !== "boolean") {
          throw new Error("invalid hostedJev");
        }
        return { enabled: value.hostedJev.enabled };
      })();
  ```

  Accept `"auto"` in the backend check. Do not add catalog loading, profile
  tiers, confidence thresholds, or new dependencies.

- [ ] **Step 4: Update the example and remove the stale executable contract.**

  Change `examples/config.json` to:

  ```json
  {
    "backend": "auto",
    "layaUrl": "http://127.0.0.1:8765",
    "hostedJev": { "enabled": false },
    "fallbackProfile": "deep",
    "profiles": {
      "fast": {
        "description": "Small localized edits",
        "model": "gpt-6-luna",
        "effort": "low"
      },
      "deep": {
        "description": "Complex debugging and review",
        "model": "gpt-6-sol",
        "effort": "high"
      }
    }
  }
  ```

  Remove the nonexistent `turnhelm-hook` entry from `package.json` while
  preserving the `turnhelm` bin and all existing scripts.

- [ ] **Step 5: Update user-facing and historical docs.**

  README must document `backend: "auto"`, the loopback-first behavior, and the
  two explicit Jev gates:

  ```text
  Hosted Jev is used only when hostedJev.enabled is true and
  TURNHELM_ALLOW_HOSTED_JEV=1. Phase A chooses one configured model/effort
  profile before Codex starts. Native subagent routing and the old Hook/Gateway
  experiments are unsupported.
  ```

  Add a short historical banner at the top of the 2026-10-02 design and plan:
  `This document is historical; use docs/superpowers/specs/2026-10-03-jev-laya-phase-a-routing-design.md and the matching 2026-10-03 plan.`
  Do not rewrite their historical task bodies.

- [ ] **Step 6: Run green tests and commit.**

  Run:

  ```bash
  npm test -- --test-name-pattern='auto mode|hosted Jev|loopback|unknown fallback'
  git diff --check
  git commit -m "refactor(config): add explicit local-first backend mode"
  ```

  Expected: all matching config tests pass and no Hook executable remains in
  the package manifest.

---

### Task 2: Implement one-shot Laya with explicit Jev fallback

**Files:**
- Modify: `src/systemone.ts`
- Modify: `test/systemone.test.ts`
- Modify: `src/route.ts` only if the return type needs no more than the existing string choice
- Modify: `test/route.test.ts` only for fallback behavior that cannot be covered by the client tests

**Interfaces:**
- `buildSystemOneRequest(config: Config, prompt: string, backend?: "laya" | "jev"): Record<string, unknown>` uses `typed-decisions` for Laya and `jev-latest` for Jev.
- `chooseProfile(config: Config, prompt: string): Promise<string>` remains the route-facing API.
- Internal `callDecision(config: Config, prompt: string, backend: "laya" | "jev"): Promise<string>` performs exactly one HTTP request and validates `direct` or a configured profile ID.

- [ ] **Step 1: Add deterministic fetch-test helpers and red tests.**

  In `test/systemone.test.ts`, replace the current single-backend fixture
  with this shared fixture and add a helper that replaces `globalThis.fetch`
  for one test and restores it in `finally`:

  ```ts
  const base = {
    backend: "laya" as const,
    layaUrl: "http://127.0.0.1:8765",
    fallbackProfile: "deep",
    hostedJev: { enabled: false },
    profiles: {
      fast: { description: "Small edits", model: "gpt-6-luna", effort: "low" },
      deep: { description: "Complex work", model: "gpt-6-sol", effort: "high" }
    }
  };

  const withFetch = async (
    implementation: typeof fetch,
    run: () => Promise<void>
  ) => {
    const original = globalThis.fetch;
    globalThis.fetch = implementation;
    try { await run(); } finally { globalThis.fetch = original; }
  };
  ```

  Add tests with a `calls` array and `Response` objects:

  ```ts
  test("auto uses successful Laya without calling Jev", async () => {
    const calls: string[] = [];
    await withFetch(async input => {
      calls.push(String(input));
      return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "fast" } } }), { status: 200 });
    }, async () => {
      const result = await chooseProfile(parseConfig({ ...base, backend: "auto" }), "Rename one file.");
      assert.equal(result, "fast");
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /127\.0\.0\.1/);
  });

  test("auto falls back to opted-in Jev after one Laya failure", async () => {
    const calls: string[] = [];
    const previous = process.env.TURNHELM_ALLOW_HOSTED_JEV;
    process.env.TURNHELM_ALLOW_HOSTED_JEV = "1";
    try {
      await withFetch(async input => {
        calls.push(String(input));
        if (calls.length === 1) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "deep" } } }), { status: 200 });
      }, async () => {
        const result = await chooseProfile(parseConfig({
          ...base,
          backend: "auto",
          hostedJev: { enabled: true }
        }), "Investigate the race.");
        assert.equal(result, "deep");
      });
    } finally {
      if (previous === undefined) delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
      else process.env.TURNHELM_ALLOW_HOSTED_JEV = previous;
    }
    assert.equal(calls.length, 2);
    assert.match(calls[1], /api\.typesafe\.ai/);
  });

  test("auto does not call Jev without both opt-ins", async () => {
    let calls = 0;
    const previous = process.env.TURNHELM_ALLOW_HOSTED_JEV;
    delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
    try {
      await withFetch(async () => {
        calls += 1;
        return new Response("unavailable", { status: 503 });
      }, async () => {
        await assert.rejects(() => chooseProfile(parseConfig({
          ...base,
          backend: "auto",
          hostedJev: { enabled: true }
        }), "Investigate the race."));
      });
    } finally {
      if (previous === undefined) delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
      else process.env.TURNHELM_ALLOW_HOSTED_JEV = previous;
    }
    assert.equal(calls, 1);
  });

  test("direct Jev requires both hosted opt-ins before fetch", async () => {
    let calls = 0;
    const previous = process.env.TURNHELM_ALLOW_HOSTED_JEV;
    delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
    try {
      await withFetch(async () => {
        calls += 1;
        return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "deep" } } }), { status: 200 });
      }, async () => {
        await assert.rejects(() => chooseProfile(parseConfig({
          ...base,
          backend: "jev",
          hostedJev: { enabled: true }
        }), "Investigate the race."));
      });
    } finally {
      if (previous === undefined) delete process.env.TURNHELM_ALLOW_HOSTED_JEV;
      else process.env.TURNHELM_ALLOW_HOSTED_JEV = previous;
    }
    assert.equal(calls, 0);
  });
  ```

  Update imports to include `chooseProfile`. Keep the existing request-builder
  tests. These tests must fail before implementation because `auto` currently
  maps to neither backend and no fallback call exists.

- [ ] **Step 2: Run the red System One tests.**

  Run:

  ```bash
  npm test -- --test-name-pattern='System One|auto uses|falls back|opt-ins|typed-decisions|jev-latest'
  ```

  Expected: the new auto/fallback tests fail while the existing builder tests
  continue to compile.

- [ ] **Step 3: Extract one backend call without changing the wire contract.**

  Refactor `src/systemone.ts` so `callDecision` chooses exactly these values:

  ```ts
  const model = backend === "jev" ? "jev-latest" : "typed-decisions";
  const base = backend === "jev" ? "https://api.typesafe.ai" : config.layaUrl;
  const key = backend === "jev" ? process.env.TYPESAFE_API_KEY : process.env.LAYA_API_KEY;
  ```

  Keep the existing `/v1/systemone` body, `AbortSignal.timeout(4000)`, JSON
  shape checks, and allowlisted choice check. Add no confidence parsing and do
  not include backend output in thrown errors.

- [ ] **Step 4: Add explicit hosted-Jev gating and one fallback transition.**

  Implement `hostedJevAllowed(config)` as the conjunction of
  `config.hostedJev.enabled` and `process.env.TURNHELM_ALLOW_HOSTED_JEV === "1"`.
  For `backend === "jev"`, reject before `fetch` when the gate is false. For
  `backend === "auto"`, call Laya first; catch its transport/status/parse errors
  and call Jev once only when `hostedJevAllowed` is true. If the Jev call fails,
  rethrow a generic classifier error so `resolvePhaseARoute` applies the
  configured fallback. Never retry Laya or Jev and never call both on Laya
  success.

- [ ] **Step 5: Verify routing fallback remains unchanged.**

  Add one `test/route.test.ts` case that stubs `fetch` to fail and confirms
  `resolvePhaseARoute` returns the configured fallback profile with
  `source === "fallback"`. Also assert a config without `fallbackProfile`
  rejects before Codex can run. Restore the global fetch after each test.

- [ ] **Step 6: Run green tests and commit.**

  Run:

  ```bash
  npm test
  git diff --check
  git commit -m "feat(router): add opted-in jev fallback for laya"
  ```

  Expected: all unit tests pass; no test records a raw task, response body, or
  secret.

---

### Task 3: Align documentation and real-service validation with the MVP

**Files:**
- Modify: `test/live.integration.ts`
- Modify: `README.md` if Task 1 did not finish the complete command examples
- Modify: `docs/validation/2026-10-02-routing-trial.md` with an appended Phase A auto-mode note
- Create: `docs/validation/2026-10-03-jev-laya-phase-a.md`

**Interfaces:**
- The live test continues to call `classifyTask` with real Laya and real Jev
  services only.
- It reports only backend, call count, p50/p95 latency, and selected profile IDs.
- Direct Jev live calls require both `hostedJev.enabled` and
  `TURNHELM_ALLOW_HOSTED_JEV=1`; missing credentials/service causes a failed
  live test, never a fixture substitution.

- [ ] **Step 1: Update the live test setup.**

  Build per-backend configs with `parseConfig({ ...loadConfig(), backend })`:

  ```ts
  const configs = [
    parseConfig({ ...loadConfig(), backend: "laya" }),
    parseConfig({ ...loadConfig(), backend: "jev", hostedJev: { enabled: true } })
  ];
  ```

  Keep the six existing labelled cases and 24 calls per backend. Do not add
  auto-mode calls to the paid live suite; the unit tests prove the transition,
  while the real suite proves both services independently.

- [ ] **Step 2: Make Jev opt-in visible and safe.**

  Add a test precondition with a clear error when the Jev case lacks
  `TURNHELM_ALLOW_HOSTED_JEV=1`; do not print the key. Keep output to the
  existing scalar latency/profile summary. Add a note that this small labelled
  set is smoke coverage, not a quality benchmark.

- [ ] **Step 3: Record the validation protocol.**

  Create `docs/validation/2026-10-03-jev-laya-phase-a.md` containing:

  - the exact commands for fast tests, live tests, `git diff --check`, and
    `npm audit --audit-level=high`;
  - required environment gates without values;
  - the six labels and 24-call count per backend;
  - fields allowed in output (source, profile, latency, status);
  - explicit prohibition on prompts, responses, headers, keys, fixtures, and
    model-catalog mutation;
  - a separate future-calibration note, marked out of scope for this MVP.

- [ ] **Step 4: Run final verification.**

  Run:

  ```bash
  npm test
  npm audit --audit-level=high
  git diff --check
  git status --short
  ```

  Run the real service suite only when the user has enabled the approved local
  Laya process and hosted Jev key:

  ```bash
  TURNHELM_ALLOW_HOSTED_JEV=1 npm run test:live
  ```

  Expected: fast tests are green, audit has no high-severity finding, the live
  command either passes with scalar output or fails clearly because a real
  service/credential is unavailable; it never silently substitutes a fake.

- [ ] **Step 5: Commit the validation/documentation boundary.**

  ```bash
  git add test/live.integration.ts README.md docs/validation/2026-10-02-routing-trial.md docs/validation/2026-10-03-jev-laya-phase-a.md
  git diff --cached --check
  git commit -m "docs(validation): define jev-laya phase a smoke gate"
  ```

---

## Completion criteria

The MVP is complete only when:

- `npm test` passes with the auto-mode and opt-in fallback tests;
- the package no longer advertises a nonexistent Hook executable;
- README and historical Hook documents no longer present native subagent
  routing as supported;
- the real-service validation protocol is documented and does not use fakes;
- `npm audit --audit-level=high` and `git diff --check` pass; and
- no Gateway, Hook, catalog cache, ensemble, confidence policy, or online
  learning code has been added.
