# Turnhelm Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Phase A one-shot Codex tasks and, in Phase B, augment only the model/effort of subagents that native Codex has already decided to spawn.

**Architecture:** A small TypeScript decision client calls real Jev or loopback Laya and resolves only allowlisted profiles. Phase A passes the result to `codex exec`. Phase B is a fail-open `PreToolUse` Hook on the documented `Agent` alias for `spawn_agent`; it preserves the complete original spawn request unless the request has no explicit model/effort and the tested input schema is recognized.

**Tech Stack:** Node.js 22+, TypeScript, built-in `fetch` and `node:test`, Codex CLI, real TypeSafe Jev API, real local `laya[serve]` HTTP process.

## Global constraints

- Do not modify Codex CLI/TUI source, add a Codex API, read/write Codex credentials, write `~/.codex/config.toml`, or configure a proxy.
- Do not add a `UserPromptSubmit` Hook. Phase B must not force delegation or a one-agent topology.
- Preserve explicit spawn model/effort, task text, agent role, number of agents, parallelism, fork settings, sandbox, and approval settings.
- Phase B fails open: backend, schema, Hook, or parsing failure emits no blocking decision and runs the original spawn.
- Never substitute a fake Jev or Laya service for a live integration test. Obtain approval before paid Jev/Codex calls or Laya checkpoint downloads.
- Prompts over 2,000 characters use Phase A fallback policy; Phase B passes an unrecognized/long spawn through unchanged.
- Keep Laya on `127.0.0.1` or `::1`. Do not log prompts, tool arguments, backend output, or secrets.
- Phase A removes `TYPESAFE_API_KEY`, `LAYA_API_KEY`, and `TURNHELM_CONFIG` from the spawned Codex environment; Phase B does not claim classifier-key isolation inside native TUI.
- Before each commit, inspect `git diff`, run `git diff --check`, and run `npm audit --audit-level=high` once `package.json` exists.

## File map

- `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`: minimal TypeScript CLI and two executable bins (`turnhelm`, `turnhelm-hook`).
- `src/config.ts`: strict config loading and profile validation.
- `src/systemone.ts`: one real Jev/Laya HTTP request and response validation.
- `src/route.ts`: classifier decision plus Phase A fallback policy.
- `src/codex.ts`, `src/cli.ts`: safe Phase A Codex subprocess and diagnostics.
- `src/spawn-hook.ts`, `src/hook-entry.ts`: spawn input extraction, minimal patching, and fail-open Hook process.
- `test/*.test.ts`: pure tests only; no fake backend presented as integration.
- `test/live.integration.ts`: 24 real calls per backend, excluded from the fast test command.
- `examples/config.json`, `examples/hooks.json`: inactive examples.
- `README.md`: setup, Phase A commands, and opt-in Phase B behavior.
- `docs/validation/2026-10-02-routing-trial.md`: real TUI baseline/Hook evidence, only after the trial.

---

### Task 1: Bootstrap and validate configuration

**Files:**
- Create: `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`
- Create: `src/config.ts`, `test/config.test.ts`, `examples/config.json`

**Interfaces:**
- `Profile = { description: string; model: string; effort: string }`.
- `Config = { backend: "laya" | "jev"; layaUrl: string; profiles: Record<string, Profile>; fallbackProfile?: string }`.
- Export `parseConfig(value: unknown): Config` and `loadConfig(path?: string): Config`.

- [ ] **Step 1: Create the failing config tests.** Use this complete test file:

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { parseConfig } from "../src/config.js";

    const base = {
      backend: "laya",
      layaUrl: "http://127.0.0.1:8765",
      fallbackProfile: "deep",
      profiles: {
        fast: { description: "Small localized edits", model: "gpt-6-luna", effort: "low" },
        deep: { description: "Complex debugging and review", model: "gpt-6-sol", effort: "high" }
      }
    };

    test("accepts a loopback backend and four-or-fewer profiles", () => {
      assert.equal(parseConfig(base).profiles.deep.effort, "high");
    });
    test("rejects public Laya URLs", () => {
      assert.throws(() => parseConfig({ ...base, layaUrl: "http://0.0.0.0:8765" }), /loopback/);
    });
    test("rejects an unknown fallback", () => {
      assert.throws(() => parseConfig({ ...base, fallbackProfile: "missing" }), /fallbackProfile/);
    });
    test("rejects unsafe profile IDs and long descriptions", () => {
      assert.throws(() => parseConfig({ ...base, profiles: { "bad-id": base.profiles.deep } }), /profile ID/);
      assert.throws(() => parseConfig({ ...base, profiles: { x: { ...base.profiles.deep, description: "x".repeat(81) } } }), /description/);
    });
    ~~~

- [ ] **Step 2: Run the failing test.** Run `npm test`. Expected: missing project scripts or `src/config.ts`; this failure is the required red state.

- [ ] **Step 3: Add the minimal project metadata.** Create these exact files:

    ~~~json
    {
      "name": "turnhelm",
      "version": "0.0.0",
      "private": true,
      "type": "module",
      "files": ["dist/src", "examples"],
      "bin": {
        "turnhelm": "./dist/src/cli.js",
        "turnhelm-hook": "./dist/src/hook-entry.js"
      },
      "scripts": {
        "build": "tsc -p tsconfig.json",
        "test": "npm run build && node --test dist/test/*.test.js",
        "test:live": "npm run build && node --test dist/test/live.integration.js"
      },
      "engines": { "node": ">=22" },
      "devDependencies": { "@types/node": "latest", "typescript": "latest" }
    }
    ~~~

    ~~~json
    {
      "compilerOptions": {
        "target": "ES2022",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "rootDir": ".",
        "outDir": "dist",
        "strict": true,
        "skipLibCheck": true
      },
      "include": ["src/**/*.ts", "test/**/*.ts"]
    }
    ~~~

    Run `npm install`. Create `.gitignore` with `node_modules/`, `dist/`, `.live-laya-venv/`, `.turnhelm-live.json`, `.codex/hooks.json`, and `.codex/hooks.json.turnhelm-trial-backup`.

- [ ] **Step 4: Implement `src/config.ts`.** Use strict own-property checks and loopback validation:

    ~~~ts
    import { readFileSync } from "node:fs";
    import { homedir } from "node:os";
    import { join } from "node:path";

    export type Backend = "laya" | "jev";
    export type Profile = { description: string; model: string; effort: string };
    export type Config = {
      backend: Backend;
      layaUrl: string;
      profiles: Record<string, Profile>;
      fallbackProfile?: string;
    };

    const isObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    const text = (value: unknown, name: string, max: number): string => {
      if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
        throw new Error("invalid " + name);
      return value.trim();
    };

    export function parseConfig(value: unknown): Config {
      if (!isObject(value)) throw new Error("config must be an object");
      if (value.backend !== "laya" && value.backend !== "jev") throw new Error("backend must be laya or jev");
      const parsed = new URL(text(value.layaUrl, "layaUrl", 200));
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || parsed.username || parsed.password)
        throw new Error("layaUrl must use HTTP loopback");
      if (!isObject(value.profiles)) throw new Error("profiles must be an object");
      const ids = Object.keys(value.profiles);
      if (ids.length < 1 || ids.length > 4) throw new Error("profiles must contain 1 to 4 entries");
      const profiles = Object.create(null) as Record<string, Profile>;
      for (const id of ids) {
        if (id === "direct" || !/^[a-z][a-z0-9_]*$/.test(id)) throw new Error("invalid profile ID");
        const raw = value.profiles[id];
        if (!isObject(raw)) throw new Error("invalid profile " + id);
        const description = text(raw.description, "description", 80);
        const model = text(raw.model, "model", 200);
        const effort = text(raw.effort, "effort", 32);
        if (!/^[a-zA-Z0-9._:/-]+$/.test(model) || !/^[a-z]+$/.test(effort)) throw new Error("invalid profile model or effort");
        profiles[id] = { description, model, effort };
      }
      const fallbackProfile = value.fallbackProfile === undefined ? undefined : text(value.fallbackProfile, "fallbackProfile", 40);
      if (fallbackProfile && !Object.hasOwn(profiles, fallbackProfile)) throw new Error("fallbackProfile must name a profile");
      return { backend: value.backend, layaUrl: parsed.origin, profiles, fallbackProfile };
    }

    export function loadConfig(path = process.env.TURNHELM_CONFIG ?? join(homedir(), ".config", "turnhelm", "config.json")): Config {
      return parseConfig(JSON.parse(readFileSync(path, "utf8")));
    }
    ~~~

- [ ] **Step 5: Add `examples/config.json` and verify.** Use profiles `fast` and `deep` matching the test fixture. Run `npm test && npm audit --audit-level=high && git diff --check`; expected: all config tests pass and no high-severity npm finding. Review and commit as `feat(config): add validated routing profiles`.

### Task 2: Real decision client and two routing policies

**Files:**
- Create: `src/systemone.ts`, `src/route.ts`, `test/route.test.ts`, `test/live.integration.ts`

**Interfaces:**
- `chooseProfile(config, prompt): Promise<string>` returns only a backend choice.
- `classifyTask(prompt, config): Promise<ClassifierDecision>` returns `{ kind: "direct" }` or `{ kind: "profile"; profileId; profile }`.
- `resolvePhaseARoute(prompt, config): Promise<RouteDecision>` applies Phase A fallback rules.
- `RouteDecision` is `{ kind: "direct"; source }` or `{ kind: "profile"; source; profileId; profile }`.

- [ ] **Step 1: Write pure routing tests before implementation.** Test continuation and long-input fallback without a backend, plus unknown classifier choice rejection. Do not create a fake Jev/Laya server.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { parseConfig } from "../src/config.js";
    import { resolvePhaseARoute } from "../src/route.js";

    const config = parseConfig({
      backend: "laya", layaUrl: "http://127.0.0.1:8765", fallbackProfile: "deep",
      profiles: { deep: { description: "Complex work", model: "gpt-6-sol", effort: "high" } }
    });
    test("short continuation uses Phase A fallback", async () => {
      const result = await resolvePhaseARoute("继续", config);
      assert.equal(result.kind, "profile");
      assert.equal(result.source, "continuation");
      assert.equal(result.profileId, "deep");
    });
    test("long input uses Phase A fallback before a backend call", async () => {
      const result = await resolvePhaseARoute("x".repeat(2001), config);
      assert.equal(result.source, "fallback");
    });
    ~~~

- [ ] **Step 2: Run `npm test` and observe the expected missing-module failure.** Do not proceed by weakening the tests.

- [ ] **Step 3: Implement `src/systemone.ts`.** Send one choice question to the real endpoint, use `jev-latest` only for Jev, omit `model` for Laya, use a four-second timeout, and validate only a choice answer. Never log request/response bodies or headers:

    ~~~ts
    import type { Config } from "./config.js";
    const object = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);

    export async function chooseProfile(config: Config, prompt: string): Promise<string> {
      const criteria: Record<string, string> = { direct: "No coding, debugging, review, or file-change work" };
      for (const [id, profile] of Object.entries(config.profiles)) criteria[id] = profile.description;
      const body: Record<string, unknown> = {
        state: prompt,
        questions: { route: { type: "choice", instructions: "Choose the best route for this coding assistant request.", criteria } }
      };
      if (config.backend === "jev") body.model = "jev-latest";
      const key = config.backend === "jev" ? process.env.TYPESAFE_API_KEY : process.env.LAYA_API_KEY;
      if (config.backend === "jev" && !key) throw new Error("TYPESAFE_API_KEY is required");
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (key) headers.authorization = "Bearer " + key;
      const base = config.backend === "jev" ? "https://api.typesafe.ai" : config.layaUrl;
      const response = await fetch(new URL("/v1/systemone", base), {
        method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(4000)
      });
      if (!response.ok) throw new Error("classifier HTTP " + response.status);
      const data: unknown = await response.json();
      if (!object(data) || !object(data.answers) || !object(data.answers.route)) throw new Error("classifier returned no route");
      const answer = data.answers.route;
      if (answer.type !== "choice" || typeof answer.choice !== "string") throw new Error("classifier returned an invalid choice");
      return answer.choice;
    }
    ~~~

- [ ] **Step 4: Implement `src/route.ts` with separate Phase A policy.** Backend errors and unknown choices throw from `classifyTask`; only `resolvePhaseARoute` catches them for an explicit fallback. Phase B will catch and pass through instead.

    ~~~ts
    import type { Config, Profile } from "./config.js";
    import { chooseProfile } from "./systemone.js";
    export type ClassifierDecision =
      | { kind: "direct" }
      | { kind: "profile"; profileId: string; profile: Profile };
    export type RouteDecision = ClassifierDecision & { source: "classifier" | "continuation" | "fallback" };
    const continuation = /^(继续|接着做|按刚才的方案继续|continue|go on|proceed)[.!。！\s]*$/i;
    const profile = (id: string, config: Config, source: RouteDecision["source"]): RouteDecision => ({
      kind: "profile", source, profileId: id, profile: config.profiles[id]
    });
    export async function classifyTask(prompt: string, config: Config): Promise<ClassifierDecision> {
      if (!prompt.trim()) throw new Error("task must not be empty");
      const choice = await chooseProfile(config, prompt);
      if (choice === "direct") return { kind: "direct" };
      if (!Object.hasOwn(config.profiles, choice)) throw new Error("classifier returned an unknown profile");
      return profile(choice, config, "classifier");
    }
    export async function resolvePhaseARoute(prompt: string, config: Config): Promise<RouteDecision> {
      if (!prompt.trim()) throw new Error("task must not be empty");
      if (continuation.test(prompt.trim()) || prompt.length > 2000) {
        if (!config.fallbackProfile) throw new Error("fallbackProfile is required for this Phase A input");
        return profile(config.fallbackProfile, config, prompt.length > 2000 ? "fallback" : "continuation");
      }
      try {
        const decision = await classifyTask(prompt, config);
        return { ...decision, source: "classifier" } as RouteDecision;
      } catch {
        if (!config.fallbackProfile) throw new Error("routing unavailable and no fallbackProfile is configured");
        return profile(config.fallbackProfile, config, "fallback");
      }
    }
    ~~~

- [ ] **Step 5: Add the real live integration test.** Use six pre-labelled synthetic Chinese/English prompts, repeated four times per backend (24 actual calls). Assert exact expected route and `source === "classifier"`; print p50/p95 only. If either real service is unavailable, fail/blocked rather than switching to a fixture.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { loadConfig } from "../src/config.js";
    import { classifyTask } from "../src/route.js";
    const cases = [
      ["What is this repository called? Do not change files.", "direct"],
      ["这个项目叫什么？只回答，不改文件。", "direct"],
      ["Rename the README heading to Turnhelm; change only that line.", "fast"],
      ["把 README 的标题改成 Turnhelm，只改这一行。", "fast"],
      ["Investigate a worker/database race, fix it, and add regression tests.", "deep"],
      ["审查认证流程中的权限提升和令牌泄漏风险，并给出证据。", "deep"]
    ] as const;
    const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    for (const backend of ["laya", "jev"] as const) test("real " + backend + " routes labelled prompts", async () => {
      const config = { ...loadConfig(), backend };
      const times: number[] = [];
      for (let repeat = 0; repeat < 4; repeat++) for (const [prompt, expected] of cases) {
        const start = performance.now();
        const result = await classifyTask(prompt, config);
        times.push(performance.now() - start);
        assert.equal(result.kind === "direct" ? "direct" : result.profileId, expected);
      }
      console.info(backend + " calls=24 p50_ms=" + percentile(times, .5).toFixed(1) + " p95_ms=" + percentile(times, .95).toFixed(1));
    });
    ~~~

- [ ] **Step 6: Provision real Laya only after approval.** Run `uv venv --seed --python 3.12 .live-laya-venv`, install `laya[serve]==0.3.22` and `pip-audit`, run `.live-laya-venv/bin/python -m pip_audit --local`, then start `LAYA_HOST=127.0.0.1 LAYA_PORT=8765 LAYA_PRELOAD=1 LAYA_MODELS=english,multilingual .live-laya-venv/bin/laya-serve`. Confirm `curl --fail --silent http://127.0.0.1:8765/health`, set `TYPESAFE_API_KEY` without printing it, copy `examples/config.json` to `.turnhelm-live.json`, and run `TURNHELM_CONFIG="$PWD/.turnhelm-live.json" npm run test:live`.

- [ ] **Step 7: Verify and commit.** Run `npm test && npm audit --audit-level=high && git diff --check`, inspect the diff, and commit as `feat(classifier): route tasks with real system one services`.

### Task 3: Phase A Codex CLI execution

**Files:**
- Create: `src/codex.ts`, `src/cli.ts`, `test/codex.test.ts`
- Modify: `README.md`

**Interfaces:**
- Export `buildCodexArgs(route, write): string[]`, `codexEnvironment(env): NodeJS.ProcessEnv`, and `runCodex(route, prompt, write): Promise<number>`.

- [ ] **Step 1: Write argv/environment tests.** Assert profile routes set model/effort, direct routes do not set a model, prompts are sent via stdin, and classifier keys are removed while `CODEX_HOME` survives.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { buildCodexArgs, codexEnvironment } from "../src/codex.js";
    test("profile route uses one-run model and effort", () => {
      assert.deepEqual(buildCodexArgs({ kind: "profile", source: "classifier", profileId: "deep", profile: { description: "x", model: "gpt-6-sol", effort: "high" } }, false), ["exec", "--sandbox", "read-only", "--model", "gpt-6-sol", "--config", 'model_reasoning_effort="high"', "-"]);
    });
    test("classifier keys do not reach Codex", () => {
      const env = codexEnvironment({ TYPESAFE_API_KEY: "x", LAYA_API_KEY: "y", TURNHELM_CONFIG: "z", CODEX_HOME: "/tmp/codex" });
      assert.equal(env.TYPESAFE_API_KEY, undefined);
      assert.equal(env.LAYA_API_KEY, undefined);
      assert.equal(env.TURNHELM_CONFIG, undefined);
      assert.equal(env.CODEX_HOME, "/tmp/codex");
    });
    ~~~

- [ ] **Step 2: Implement safe subprocess execution.** Use `spawn("codex", args, { shell: false, stdio: ["pipe", "inherit", "inherit"], env: codexEnvironment() })`; write the prompt to stdin and return the exit code. Never concatenate a shell command.

    ~~~ts
    import { spawn } from "node:child_process";
    import type { RouteDecision } from "./route.js";
    export function buildCodexArgs(route: RouteDecision, write: boolean): string[] {
      const args = ["exec", "--sandbox", write ? "workspace-write" : "read-only"];
      if (route.kind === "profile") args.push("--model", route.profile.model, "--config", 'model_reasoning_effort="' + route.profile.effort + '"');
      return [...args, "-"];
    }
    export function codexEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
      const copy = { ...env };
      delete copy.TYPESAFE_API_KEY;
      delete copy.LAYA_API_KEY;
      delete copy.TURNHELM_CONFIG;
      return copy;
    }
    export async function runCodex(route: RouteDecision, prompt: string, write: boolean): Promise<number> {
      const child = spawn("codex", buildCodexArgs(route, write), { shell: false, stdio: ["pipe", "inherit", "inherit"], env: codexEnvironment() });
      if (!child.stdin) throw new Error("Codex stdin unavailable");
      child.stdin.end(prompt);
      return await new Promise<number>((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code ?? 1)); });
    }
    ~~~

- [ ] **Step 3: Implement `src/cli.ts`.** Support `turnhelm route "task"` diagnostics and `turnhelm codex [--write] "task"`; print no original prompt on errors. Run unit tests, then confirm the number of paid Codex smoke calls before testing every configured profile.

- [ ] **Step 4: Update README.md and commit.** Document config, real backend prerequisites, Phase A commands, no silent model fallback, and the fact that Phase B will not affect tasks that do not spawn. Run `npm test && npm audit --audit-level=high && git diff --check`; commit as `feat(cli): run routed codex tasks`.

### Task 4: Fail-open spawn-time Hook adapter

**Files:**
- Create: `src/spawn-hook.ts`, `src/hook-entry.ts`, `test/spawn-hook.test.ts`, `examples/hooks.json`
- Modify: `package.json`, `README.md`

**Interfaces:**
- `SpawnSchema = { toolName: "Agent"; taskKey: string; modelKey: string; effortKey: string }`.
- `extractSpawnTask(input, schema): string | null`.
- `augmentSpawnInput(input, schema, decision): unknown | null` where `null` means emit no Hook output and preserve the original call.
- `formatPreToolUseOutput(updatedInput): object` returns the documented `permissionDecision: "allow"`/`updatedInput` shape.

- [ ] **Step 1: Discover the installed spawn schema before coding the adapter.** Create a temporary `/tmp/turnhelm-agent-shape.mjs` command that reads the Hook JSON from stdin, prints only `{hook_event_name, tool_name, shape(tool_input)}` to stderr, where `shape` recursively preserves object keys and primitive type names but replaces all values. In a trusted test repo, run a temporary `PreToolUse` matcher `^Agent$` while making Codex perform one user-requested spawn. Record the Codex version and observed task/model/effort paths in the validation notes; never record values. If `tool_name` is not `Agent` or the fields are not stable, stop Phase B and leave the adapter pass-through.

- [ ] **Step 2: Write pure adapter tests using the observed schema.** The tests must cover direct route, profile route with no explicit fields, explicit model, explicit effort, missing task path, long task, unknown tool input, and exact preservation of unrelated fields. Use an injected `ClassifierDecision`; do not fake Jev/Laya.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { augmentSpawnInput, extractSpawnTask, formatPreToolUseOutput, type SpawnSchema } from "../src/spawn-hook.js";
    const schema: SpawnSchema = { toolName: "Agent", taskKey: "message", modelKey: "model", effortKey: "reasoning_effort" };
    const profile = { kind: "profile" as const, profileId: "deep", profile: { description: "x", model: "gpt-6-sol", effort: "high" } };
    test("recognized task is extracted", () => assert.equal(extractSpawnTask({ message: "Fix the parser", agent_type: "worker" }, schema), "Fix the parser"));
    test("profile adds only model and effort", () => {
      const input = { message: "Fix the parser", agent_type: "worker", fork_turns: 2 };
      const updated = augmentSpawnInput(input, schema, profile);
      assert.deepEqual(updated, { message: "Fix the parser", agent_type: "worker", fork_turns: 2, model: "gpt-6-sol", reasoning_effort: "high" });
    });
    test("direct and explicit settings pass through", () => {
      assert.equal(augmentSpawnInput({ message: "x" }, schema, { kind: "direct" }), null);
      assert.equal(augmentSpawnInput({ message: "x", model: "gpt-6-luna" }, schema, profile), null);
      assert.equal(augmentSpawnInput({ message: "x", reasoning_effort: "low" }, schema, profile), null);
    });
    test("missing or long task passes through", () => {
      assert.equal(augmentSpawnInput({ agent_type: "worker" }, schema, profile), null);
      assert.equal(augmentSpawnInput({ message: "x".repeat(2001) }, schema, profile), null);
    });
    test("Hook output uses the documented local-tool rewrite shape", () => {
      assert.deepEqual(formatPreToolUseOutput({ message: "x", model: "gpt-6-sol", reasoning_effort: "high" }), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { message: "x", model: "gpt-6-sol", reasoning_effort: "high" } } });
    });
    ~~~

- [ ] **Step 3: Implement the adapter as a narrow copy-on-write function.** It must return `null` unless the schema matches, the task is a string of at most 2,000 characters, neither explicit route field exists, and the classifier returns a validated profile. Never mutate the original object.

    ~~~ts
    import type { ClassifierDecision } from "./route.js";
    export type SpawnSchema = { toolName: "Agent"; taskKey: string; modelKey: string; effortKey: string };
    const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    export function extractSpawnTask(input: unknown, schema: SpawnSchema): string | null {
      if (!object(input)) return null;
      const value = input[schema.taskKey];
      return typeof value === "string" && value.trim() && value.length <= 2000 ? value : null;
    }
    export function augmentSpawnInput(input: unknown, schema: SpawnSchema, decision: ClassifierDecision): Record<string, unknown> | null {
      if (!object(input) || decision.kind !== "profile" || !extractSpawnTask(input, schema)) return null;
      if (Object.hasOwn(input, schema.modelKey) || Object.hasOwn(input, schema.effortKey)) return null;
      return { ...input, [schema.modelKey]: decision.profile.model, [schema.effortKey]: decision.profile.effort };
    }
    export function formatPreToolUseOutput(updatedInput: Record<string, unknown>): object {
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } };
    }
    ~~~

- [ ] **Step 4: Implement `src/hook-entry.ts` with fail-open semantics.** Validate only `hook_event_name`, `tool_name`, and object `tool_input`; call `classifyTask` with the extracted subtask; on every error write nothing and exit 0. On success write only `formatPreToolUseOutput(updatedInput)`. Do not emit `decision: block`.

- [ ] **Step 5: Add the inactive project Hook.** `examples/hooks.json` must contain only this event, with no `UserPromptSubmit` entry:

    ~~~json
    {
      "hooks": {
        "PreToolUse": [{
          "matcher": "^Agent$",
          "hooks": [{
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/dist/src/hook-entry.js\"",
            "timeout": 5
          }]
        }]
      }
    }
    ~~~

    Add `"turnhelm-hook": "./dist/src/hook-entry.js"` to the package `bin` map for later user-level installation, but do not install it globally in this task.

- [ ] **Step 6: Verify pure Hook behavior.** Run `npm test && npm audit --audit-level=high && git diff --check`; pipe one synthetic `PreToolUse` object to the entrypoint only when a real backend is available, and confirm direct/classifier failure produce no stdout while a real profile produces a minimal updatedInput. Commit as `feat(hook): route existing agent spawns`.

### Task 5: Native orchestration trial and optional promotion

**Files:**
- Create after the trial: `docs/validation/2026-10-02-routing-trial.md`
- Modify: `README.md` only for observed operational facts
- User-managed, ignored during the trial: `.codex/hooks.json`

**Interfaces:**
- Consumes the built Hook and real Laya/Jev services.
- Produces a go/no-go report proving topology preservation; it does not retire Phase A.

- [ ] **Step 1: Provision live services with approval.** Run the real 24-call/backend test from Task 2. Use keyless loopback Laya for the native TUI trial when possible. Record package versions and Codex version; redact keys.

- [ ] **Step 2: Establish a no-Hook baseline in a trusted test repository.** Run native Codex with no Turnhelm Hook and execute these synthetic scenarios: (a) ask Codex to solve a small task without delegation, (b) explicitly request one subagent, (c) explicitly request two parallel agents with distinct roles, (d) explicitly request a model/effort, and (e) use a configured custom agent role. Record child count, role/type, task messages, parallelism, effective model/effort, parent work, and token/latency observations.

- [ ] **Step 3: Run the schema probe and install the project-local Hook.** After explicit approval, copy `examples/hooks.json` to `.codex/hooks.json`, run `/hooks`, trust the exact Hook, and run the same scenarios. The probe must record only key/type shapes. If `Agent` is not emitted, `updatedInput` is rejected, or the task/model/effort paths differ without a safe adapter, mark Phase B unsupported and keep the baseline.

- [ ] **Step 4: Compare baseline and Hook runs.** Require unchanged child count, roles, task messages, parallelism, and parent behavior in all scenarios. Require explicit model/effort to remain unchanged. Require only an unspecified generic spawn to receive the two-field patch. Run one classifier-unavailable scenario and verify the spawn proceeds unchanged. Inspect effective child settings because custom agent files and parent runtime overrides may take precedence.

- [ ] **Step 5: Publish the evidence and make the go/no-go decision.** Include Codex version, sanitized schema, backend, scenario IDs, topology comparison, effective settings, latency, tokens, and failures. Do not promote if any topology or explicit-setting regression appears. Keep Phase A available regardless of the result.

- [ ] **Step 6: Optional user-level promotion after approval.** Build and install a tested package snapshot, remove the project-local trial Hook, inspect existing user Hook entries for conflicts, and merge—not replace—the following handler:

    ~~~json
    {
      "PreToolUse": [{
        "matcher": "^Agent$",
        "hooks": [{
          "type": "command",
          "command": "turnhelm-hook",
          "timeout": 5
        }]
      }]
    }
    ~~~

    Do not edit `~/.codex/config.toml` or auth data. If the user Hook already has a Turnhelm/agent-routing handler, stop rather than duplicate it. Re-run the second-repository topology test after promotion. Do not remove `turnhelm codex` or `turnhelm route`.

## Source references

- [OpenAI Docs: Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenAI Docs: Codex Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI Docs: non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [TypeSafe Jev OpenAPI](https://api.typesafe.ai/openapi.json)
- [Laya published package](https://pypi.org/project/laya/)
