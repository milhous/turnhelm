# Turnhelm Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route one Codex task through a real Jev or local Laya decision first, then trial automatic task delegation inside the unmodified native Codex TUI.

**Architecture:** One small TypeScript classifier maps a prompt to direct handling or a validated model/effort profile. Phase A passes that profile to codex exec; Phase B reuses the classifier in a synchronous UserPromptSubmit hook that asks the main thread to delegate one coding task to a subagent. Codex retains its own auth, provider, session, and tool policy.

**Tech Stack:** Node.js 22+, TypeScript, built-in fetch and node:test, Codex CLI, real TypeSafe Jev API, real local laya[serve] HTTP process.

## Global Constraints

- Do not modify Codex CLI/TUI source, add a Codex API, read or write Codex credentials, write ~/.codex/config.toml, or configure an inference proxy.
- Inherit the user's current Codex provider and configuration; do not use --ignore-user-config.
- Never substitute a fake Jev or Laya service for a live integration test.
- Prompts over 2,000 characters use the explicit fallback before any backend call; no silent truncation.
- Keep the Laya listener on 127.0.0.1 or ::1. Use the official Jev endpoint and TYPESAFE_API_KEY from the environment.
- Do not put raw prompts, backend text, or secrets in logs or generated hook developer context.
- Phase A removes TYPESAFE_API_KEY and LAYA_API_KEY from the spawned Codex environment; B's classifier-key exposure through the native TUI environment is disclosed, not hidden.
- Phase B is best-effort subagent delegation, not a main-thread model switch or a security enforcement boundary.
- Confirm the real-call count and any paid usage with the user before Jev or Codex live tests; no real model calls occur while writing this plan.
- Before each commit, review the diff and run npm audit when package.json exists; audit the isolated Python Laya environment before relying on it.

## File map

- package.json, package-lock.json, tsconfig.json, .gitignore: minimal TypeScript CLI and test build.
- src/config.ts: one JSON config loader and strict validation.
- src/systemone.ts: one real HTTP request and narrow choice-response validation.
- src/route.ts: deterministic continuation rule, classifier call, and explicit fallback.
- src/codex.ts: safe codex exec argv construction and subprocess launch.
- src/cli.ts: Phase A codex command and read-only route diagnostic.
- src/hook.ts, src/hook-entry.ts: pure hook output formatting and JSON-on-stdin adapter.
- package.json exposes turnhelm-hook as a second local bin for the later user-level hook; no plugin package is added.
- test/*.test.ts: pure config, routing-rule, argv, and hook-format tests; no simulated decision backend.
- test/live.integration.ts: real calls to both Laya and Jev, excluded from the fast default test command.
- examples/config.json, examples/hooks.json: editable config example and an inactive project-local hook example.
- README.md: operation and limitations.
- docs/validation/2026-09-30-routing-trial.md: observations from real Codex and TUI trials, written only with actual results.

---

### Task 1: Minimal project and validated route configuration

**Files:**
- Create: package.json, package-lock.json, tsconfig.json, .gitignore
- Create: src/config.ts, test/config.test.ts, examples/config.json

**Interfaces:**
- Produces: Backend, Profile, Config, parseConfig(value), and loadConfig(path?) from src/config.ts.
- Config keys: backend, layaUrl, profiles, and optional fallbackProfile. The default path is $HOME/.config/turnhelm/config.json; TURNHELM_CONFIG overrides it for live tests.

- [ ] **Step 1: Write the failing config tests.** Create test/config.test.ts with valid and invalid cases:

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { parseConfig } from "../src/config.js";

    const base = {
      backend: "laya",
      layaUrl: "http://127.0.0.1:8765",
      fallbackProfile: "deep",
      profiles: {
        fast: { description: "Small, localized code changes", model: "gpt-6-luna", effort: "low" },
        deep: { description: "Complex debugging and review", model: "gpt-6-sol", effort: "high" }
      }
    };
    test("accepts one loopback config", () => {
      assert.equal(parseConfig(base).profiles.deep.effort, "high");
    });
    test("rejects a public Laya listener", () => {
      assert.throws(() => parseConfig({ ...base, layaUrl: "http://0.0.0.0:8765" }), /loopback/);
    });
    test("rejects an unknown fallback", () => {
      assert.throws(() => parseConfig({ ...base, fallbackProfile: "missing" }), /fallbackProfile/);
    });
    test("rejects an unsafe profile ID", () => {
      assert.throws(() => parseConfig({ ...base, profiles: { "bad\nid": base.profiles.deep } }), /profile ID/);
    });
    ~~~

- [ ] **Step 2: Run the test to confirm the missing implementation fails.** Run: npm test. Expected: missing package script or missing src/config.ts; do not treat that failure as a passing test.

- [ ] **Step 3: Add the smallest package and compiler setup.** Use these exact scripts and compile both src and test:

    ~~~json
    {
      "name": "turnhelm",
      "version": "0.0.0",
      "private": true,
      "type": "module",
      "files": ["dist/src"],
      "bin": { "turnhelm": "./dist/src/cli.js" },
      "scripts": {
        "build": "tsc -p tsconfig.json",
        "test": "npm run build && node --test dist/test/*.test.js",
        "test:live": "npm run build && node --test dist/test/live.integration.js"
      },
      "engines": { "node": ">=22" }
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

    Run: npm install --save-dev typescript @types/node. Create .gitignore with the following exact lines; npm creates and pins package-lock.json.

    ~~~text
    node_modules/
    dist/
    .live-laya-venv/
    .turnhelm-live.json
    .codex/hooks.json
    .codex/hooks.json.turnhelm-trial-backup
    ~~~

- [ ] **Step 4: Implement src/config.ts.** Keep parsing local and reject arbitrary hostnames, control characters in model settings, reserved direct IDs, more than four profiles, and missing fallback references. Use this interface:

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
    const object = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const clean = (v: unknown, name: string, max = 200): string => {
      if (typeof v !== "string" || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v))
        throw new Error("invalid " + name);
      return v.trim();
    };
    export function parseConfig(value: unknown): Config {
      if (!object(value)) throw new Error("config must be an object");
      if (value.backend !== "laya" && value.backend !== "jev")
        throw new Error("backend must be laya or jev");
      const layaUrl = clean(value.layaUrl, "layaUrl");
      const url = new URL(layaUrl);
      const host = url.hostname.replace(/^\[|\]$/g, "");
      if (url.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || url.username || url.password)
        throw new Error("layaUrl must use HTTP loopback");
      if (!object(value.profiles)) throw new Error("profiles must be an object");
      const ids = Object.keys(value.profiles);
      if (ids.length < 1 || ids.length > 4) throw new Error("profiles must contain 1 to 4 entries");
      const profiles = Object.create(null) as Record<string, Profile>;
      for (const id of ids) {
        if (id === "direct" || !/^[a-z][a-z0-9_]*$/.test(id)) throw new Error("invalid profile ID");
        const raw = value.profiles[id];
        if (!object(raw)) throw new Error("invalid profile " + id);
        const model = clean(raw.model, "model");
        const effort = clean(raw.effort, "effort", 32);
        if (!/^[a-zA-Z0-9._:/-]+$/.test(model) || !/^[a-z]+$/.test(effort))
          throw new Error("invalid profile model or effort");
        profiles[id] = { description: clean(raw.description, "description", 80), model, effort };
      }
      const fallbackProfile = value.fallbackProfile === undefined
        ? undefined : clean(value.fallbackProfile, "fallbackProfile", 40);
      if (fallbackProfile && !Object.hasOwn(profiles, fallbackProfile))
        throw new Error("fallbackProfile must name a profile");
      return { backend: value.backend, layaUrl: url.origin, profiles, fallbackProfile };
    }
    export function loadConfig(path = process.env.TURNHELM_CONFIG ??
      join(homedir(), ".config", "turnhelm", "config.json")): Config {
      return parseConfig(JSON.parse(readFileSync(path, "utf8")));
    }
    ~~~

    Create examples/config.json with this complete example. Its Codex model names must be replaced if the signed-in account cannot use them.

    ~~~json
    {
      "backend": "laya",
      "layaUrl": "http://127.0.0.1:8765",
      "fallbackProfile": "deep",
      "profiles": {
        "fast": {
          "description": "Small, localized code changes with straightforward tests",
          "model": "gpt-6-luna",
          "effort": "low"
        },
        "deep": {
          "description": "Multi-file debugging, design changes, security review, and ambiguous coding work",
          "model": "gpt-6-sol",
          "effort": "high"
        }
      }
    }
    ~~~

- [ ] **Step 5: Verify and commit.** Run: npm test && npm audit --audit-level=high && git diff --check. Expected: four config tests pass, audit reports no high-severity findings, and the diff check is empty. Review git diff; commit as feat(config): add validated routing profiles.

### Task 2: Real System One decision client

**Files:**
- Create: src/systemone.ts, src/route.ts, test/route.test.ts, test/live.integration.ts
- Modify: package.json only if the live script needs an adjustment

**Interfaces:**
- Consumes: Config and Profile from Task 1.
- Produces: chooseProfile(config, prompt): Promise<string> in src/systemone.ts; classifyTask(prompt, config): Promise<RouteDecision> and continuationProfile(prompt, config) in src/route.ts.
- RouteDecision is direct or delegate with profileId, profile, and source equal to classifier, continuation, or fallback.

- [ ] **Step 1: Write deterministic tests before the classifier.** test/route.test.ts should assert that the exact prompts 继续, 接着做, continue, and go on use fallbackProfile without a backend call, while status questions do not match the continuation rule. No fake Jev or Laya is introduced.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { classifyTask, continuationProfile } from "../src/route.js";
    import { parseConfig } from "../src/config.js";
    const config = parseConfig({
      backend: "laya", layaUrl: "http://127.0.0.1:8765", fallbackProfile: "deep",
      profiles: { deep: { description: "Complex work", model: "gpt-6-sol", effort: "high" } }
    });
    test("explicit continuations use the conservative profile", () => {
      for (const prompt of ["继续", "接着做", "continue", "go on"])
        assert.equal(continuationProfile(prompt, config), "deep");
    });
    test("a status question is not a continuation", () => {
      assert.equal(continuationProfile("What is the current status?", config), null);
    });
    test("a long task uses fallback without contacting a backend", async () => {
      const route = await classifyTask("x".repeat(2001), config);
      assert.equal(route.kind, "delegate");
      assert.equal(route.source, "fallback");
    });
    ~~~

- [ ] **Step 2: Run npm test.** Expected: compile failure because src/route.ts does not yet exist.

- [ ] **Step 3: Implement one real HTTP client.** src/systemone.ts must send one choice question, use jev-latest only for Jev, omit model for Laya so its router can choose a language checkpoint, enforce a four-second request timeout, and accept only a choice string. Do not log headers, body, prompt, or full response.

    ~~~ts
    import type { Config } from "./config.js";
    const isObject = (v: unknown): v is Record<string, unknown> =>
      typeof v === "object" && v !== null && !Array.isArray(v);

    export async function chooseProfile(config: Config, prompt: string): Promise<string> {
      const criteria: Record<string, string> = {
        direct: "Status, clarification, or conversation with no coding, debugging, or review work"
      };
      for (const [id, profile] of Object.entries(config.profiles))
        criteria[id] = profile.description;
      const body: Record<string, unknown> = {
        state: prompt,
        questions: {
          route: {
            type: "choice",
            instructions: "Choose the one route that best fits this coding assistant request. Context-dependent work is not direct.",
            criteria
          }
        }
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
      if (!isObject(data) || !isObject(data.answers))
        throw new Error("classifier returned no answers");
      const answer = data.answers.route;
      if (!isObject(answer) || answer.type !== "choice" || typeof answer.choice !== "string")
        throw new Error("classifier returned an invalid choice answer");
      return answer.choice;
    }
    ~~~

- [ ] **Step 4: Implement the routing decision.** src/route.ts must never execute a model name from backend output; it looks up an allowlisted profile. Catch backend and unknown-choice failures only to use the configured fallback. Keep configuration errors outside that catch.

    ~~~ts
    import type { Config, Profile } from "./config.js";
    import { chooseProfile } from "./systemone.js";
    export type RouteDecision =
      | { kind: "direct"; source: "classifier" }
      | { kind: "delegate"; source: "classifier" | "continuation" | "fallback";
          profileId: string; profile: Profile };
    const continuation = /^(继续|接着做|按刚才的方案继续|continue|go on|proceed)[.!。！\s]*$/i;
    export function continuationProfile(prompt: string, config: Config): string | null {
      if (!continuation.test(prompt.trim())) return null;
      if (!config.fallbackProfile) throw new Error("continuation requires fallbackProfile");
      return config.fallbackProfile;
    }
    const delegated = (id: string, config: Config, source: "classifier" | "continuation" | "fallback"):
      RouteDecision => ({ kind: "delegate", source, profileId: id, profile: config.profiles[id] });
    export async function classifyTask(prompt: string, config: Config): Promise<RouteDecision> {
      if (!prompt.trim()) throw new Error("task must not be empty");
      if (prompt.length > 2000) {
        if (config.fallbackProfile) return delegated(config.fallbackProfile, config, "fallback");
        throw new Error("long task requires fallbackProfile");
      }
      const continued = continuationProfile(prompt, config);
      if (continued) return delegated(continued, config, "continuation");
      try {
        const choice = await chooseProfile(config, prompt);
        if (choice === "direct") return { kind: "direct", source: "classifier" };
        if (!Object.hasOwn(config.profiles, choice))
          throw new Error("classifier returned an unknown profile");
        return delegated(choice, config, "classifier");
      } catch {
        if (config.fallbackProfile) return delegated(config.fallbackProfile, config, "fallback");
        throw new Error("routing unavailable and no fallbackProfile is configured");
      }
    }
    ~~~

- [ ] **Step 5: Write the live integration test before claiming any backend works.** test/live.integration.ts calls each real endpoint 24 times using six labelled, synthetic English/Chinese cases repeated four times. Assert source is classifier, record actual choices and latencies, and fail on a wrong expected route; do not modify expected labels to conceal errors.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { loadConfig } from "../src/config.js";
    import { classifyTask } from "../src/route.js";
    const cases = [
      { prompt: "What is this repository called? Do not change files.", expected: "direct" },
      { prompt: "这个项目叫什么？只回答，不改文件。", expected: "direct" },
      { prompt: "Rename the README heading to Turnhelm; change only that line.", expected: "fast" },
      { prompt: "把 README 的标题改成 Turnhelm，只改这一行。", expected: "fast" },
      { prompt: "Investigate a race between a worker queue and a database transaction; fix it and add regression tests.", expected: "deep" },
      { prompt: "审查认证流程中的权限提升和令牌泄漏风险，并给出证据。", expected: "deep" }
    ] as const;
    const percentile = (values: number[], fraction: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.ceil(sorted.length * fraction) - 1];
    };
    for (const backend of ["laya", "jev"] as const) {
      test("real " + backend + " routes labelled tasks", async () => {
        const config = { ...loadConfig(), backend };
        assert.ok(config.profiles.fast && config.profiles.deep, "live config needs fast and deep");
        const elapsed: number[] = [];
        for (let repeat = 0; repeat < 4; repeat++) for (const item of cases) {
          const start = performance.now();
          const route = await classifyTask(item.prompt, config);
          elapsed.push(performance.now() - start);
          assert.equal(route.source, "classifier", "fallback must not mask a failed live backend");
          assert.equal(route.kind === "direct" ? "direct" : route.profileId, item.expected);
        }
        console.info(backend + " calls=24 p50_ms=" + percentile(elapsed, 0.5).toFixed(1) +
          " p95_ms=" + percentile(elapsed, 0.95).toFixed(1));
      });
    }
    ~~~

- [ ] **Step 6: Provision and run real services, with no mock fallback.** On this machine Laya was not installed at planning time. Confirm approval for the Laya checkpoint download and 24 real Jev calls before proceeding. Use a separate local environment:

    ~~~sh
    uv venv --seed --python 3.12 .live-laya-venv
    uv pip install --python .live-laya-venv/bin/python "laya[serve]==0.3.22"
    uv pip install --python .live-laya-venv/bin/python pip-audit
    .live-laya-venv/bin/python -m pip_audit --local
    LAYA_HOST=127.0.0.1 LAYA_PORT=8765 LAYA_PRELOAD=1 LAYA_MODELS=english,multilingual .live-laya-venv/bin/laya-serve
    ~~~

    In another terminal run the following. Edit only the model slugs in the ignored live config if account access requires it; do not put credentials in the JSON file.

    ~~~sh
    curl --fail --silent http://127.0.0.1:8765/health
    printenv TYPESAFE_API_KEY >/dev/null || { echo "TYPESAFE_API_KEY is missing" >&2; exit 1; }
    cp examples/config.json .turnhelm-live.json
    TURNHELM_CONFIG="$PWD/.turnhelm-live.json" npm run test:live
    ~~~

    Expected: 24 actual calls per backend, correct route labels, source=classifier, and printed p50/p95. If either service is unavailable or inaccurate, stop Phase A and report the result; do not pass with fixtures.

- [ ] **Step 7: Verify and commit.** Run npm test && npm audit --audit-level=high && git diff --check, review the diff, and commit as feat(classifier): route tasks with real system one services. Live test output is required evidence for completion of this task; the fast unit suite alone is insufficient.

### Task 3: Phase A Codex CLI execution

**Files:**
- Create: src/codex.ts, src/cli.ts, test/codex.test.ts
- Modify: README.md

**Interfaces:**
- Consumes: loadConfig and classifyTask.
- Produces: buildCodexArgs(route, write): string[], codexEnvironment(env): NodeJS.ProcessEnv, and runCodex(route, prompt, write): Promise<number>.

- [ ] **Step 1: Test safe argv construction.** test/codex.test.ts should check that direct uses no model override, delegate sets both model and effort, and the prompt is not an argv element:

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { buildCodexArgs, codexEnvironment } from "../src/codex.js";
    test("delegate selects model and effort without embedding the prompt", () => {
      const args = buildCodexArgs({
        kind: "delegate", source: "classifier", profileId: "deep",
        profile: { description: "Complex work", model: "gpt-6-sol", effort: "high" }
      }, false);
      assert.deepEqual(args, ["exec", "--sandbox", "read-only", "--model", "gpt-6-sol",
        "--config", 'model_reasoning_effort="high"', "-"]);
    });
    test("classifier keys are not inherited by Codex", () => {
      const env = codexEnvironment({
        TYPESAFE_API_KEY: "test-key", LAYA_API_KEY: "local-key", CODEX_HOME: "/tmp/codex"
      });
      assert.equal(env.TYPESAFE_API_KEY, undefined);
      assert.equal(env.LAYA_API_KEY, undefined);
      assert.equal(env.CODEX_HOME, "/tmp/codex");
    });
    ~~~

- [ ] **Step 2: Run npm test; expect a missing src/codex.ts failure.**

- [ ] **Step 3: Add src/codex.ts.** Pass the task on stdin, use argv with shell=false, inherit Codex's environment, and return Codex's exit status:

    ~~~ts
    import { spawn } from "node:child_process";
    import type { RouteDecision } from "./route.js";
    export function buildCodexArgs(route: RouteDecision, write: boolean): string[] {
      const args = ["exec", "--sandbox", write ? "workspace-write" : "read-only"];
      if (route.kind === "delegate")
        args.push("--model", route.profile.model, "--config",
          'model_reasoning_effort="' + route.profile.effort + '"');
      args.push("-");
      return args;
    }
    export function codexEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
      const copy = { ...env };
      delete copy.TYPESAFE_API_KEY;
      delete copy.LAYA_API_KEY;
      delete copy.TURNHELM_CONFIG;
      return copy;
    }
    export async function runCodex(route: RouteDecision, prompt: string, write: boolean): Promise<number> {
      const child = spawn("codex", buildCodexArgs(route, write), {
        stdio: ["pipe", "inherit", "inherit"], shell: false, env: codexEnvironment()
      });
      if (!child.stdin) throw new Error("Codex stdin unavailable");
      child.stdin.end(prompt);
      return await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", code => resolve(code ?? 1));
      });
    }
    ~~~

- [ ] **Step 4: Add src/cli.ts with just codex and route commands.** route prints only route/profile/model/effort metadata, never the original task. codex accepts an optional --write before the task:

    ~~~ts
    #!/usr/bin/env node
    import { loadConfig } from "./config.js";
    import { classifyTask } from "./route.js";
    import { runCodex } from "./codex.js";
    async function main() {
      const [command, ...rest] = process.argv.slice(2);
      const write = command === "codex" && rest[0] === "--write";
      const prompt = (write ? rest.slice(1) : rest).join(" ").trim();
      if (!["codex", "route"].includes(command ?? "") || !prompt)
        throw new Error('usage: turnhelm codex [--write] "<task>" | turnhelm route "<task>"');
      const decision = await classifyTask(prompt, loadConfig());
      if (command === "route") {
        console.log(JSON.stringify(decision));
      } else {
        process.exitCode = await runCodex(decision, prompt, write);
      }
    }
    main().catch(() => {
      console.error("Turnhelm could not route this task; check config and backend availability.");
      process.exitCode = 1;
    });
    ~~~

- [ ] **Step 5: Verify A with a real read-only Codex call.** Confirm the number of paid Codex smokes with the user. After npm test, run TURNHELM_CONFIG="$PWD/.turnhelm-live.json" node dist/src/cli.js codex "Summarize README.md without editing files." using the real selected backend and existing Codex login. Expected: a successful final answer, no modified files, and no Codex authentication/config writes by Turnhelm. For each configured profile, run one separate read-only smoke to establish that Codex accepts the pair; do not silently replace rejected pairs.

- [ ] **Step 6: Document A and commit.** Replace README.md with a short operational guide containing this exact Phase A content:

    ~~~markdown
    # turnhelm

    Local-first task routing for Codex. Turnhelm chooses a validated model and
    reasoning-effort profile; Codex keeps its own authentication and provider.

    Copy examples/config.json to ~/.config/turnhelm/config.json and set model
    names your Codex account can use. Set backend to laya for a real local
    loopback laya[serve] process, or jev for the hosted TypeSafe service with
    TYPESAFE_API_KEY in the environment. Hosted Jev receives the submitted
    task text. Turnhelm does not log it or store the key.

    ## Phase A

    Run turnhelm route "task" to inspect the selected profile without starting
    Codex. Run turnhelm codex "task" for read-only Codex execution, or
    turnhelm codex --write "task" for workspace-write. A backend failure uses
    only the configured fallbackProfile; without one, the task stops before
    Codex runs. Model-access failures do not trigger another model.
    ~~~

    Run npm test && npm audit --audit-level=high && git diff --check, inspect git status and diff, then commit as feat(cli): run routed codex tasks.

### Task 4: Phase B hook adapter, without extra control hooks

**Files:**
- Create: src/hook.ts, src/hook-entry.ts, test/hook.test.ts, examples/hooks.json
- Modify: package.json, README.md

**Interfaces:**
- Consumes: loadConfig and classifyTask.
- Produces: formatHookOutput(route): object | null. The entry reads one Codex UserPromptSubmit JSON event from stdin and writes only a supported JSON hook response.

- [ ] **Step 1: Write hook-format tests.** Verify direct emits no context and a delegated response includes only validated profile metadata, not the prompt:

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { fileURLToPath } from "node:url";
    import { formatHookOutput } from "../src/hook.js";
    test("direct needs no added context", () => {
      assert.equal(formatHookOutput({ kind: "direct", source: "classifier" }), null);
    });
    test("delegate requests one child with explicit settings", () => {
      const output = formatHookOutput({
        kind: "delegate", source: "classifier", profileId: "deep",
        profile: { description: "Complex work", model: "gpt-6-sol", effort: "high" }
      });
      const text = JSON.stringify(output);
      assert.ok(text);
      assert.match(text, /gpt-6-sol/);
      assert.match(text, /reasoning_effort/);
      assert.doesNotMatch(text, /original user prompt/);
    });
    test("invalid local config blocks rather than silently continuing", () => {
      const entry = fileURLToPath(new URL("../src/hook-entry.js", import.meta.url));
      const result = spawnSync(process.execPath, [entry], {
        encoding: "utf8",
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Fix a bug" }),
        env: { ...process.env, TURNHELM_CONFIG: "/turnhelm/no-such-config.json" }
      });
      assert.equal(result.status, 0);
      assert.equal(JSON.parse(result.stdout).decision, "block");
    });
    ~~~

- [ ] **Step 2: Run npm test; expect a missing src/hook.ts failure.**

- [ ] **Step 3: Implement the narrow formatter.** No prompt argument is accepted, so raw prompt text cannot be echoed accidentally:

    ~~~ts
    import type { RouteDecision } from "./route.js";
    export function formatHookOutput(route: RouteDecision): object | null {
      if (route.kind === "direct") return null;
      const instruction = "Turnhelm selected profile " + route.profileId +
        ". Delegate this coding task to exactly one subagent with explicit model " +
        route.profile.model + " and reasoning_effort " + route.profile.effort +
        ". Pass the user's original request and relevant conversation context. " +
        "Wait for the subagent. Report its result. Do not do the coding work in the main thread. " +
        "If the requested model fails, report that failure without trying another model.";
      return { hookSpecificOutput: {
        hookEventName: "UserPromptSubmit", additionalContext: instruction
      } };
    }
    ~~~

- [ ] **Step 4: Implement the entry process.** Catch config, timeout, and response errors to return an explicit block. Do not print exception text, prompt, or tokens:

    ~~~ts
    #!/usr/bin/env node
    import { loadConfig } from "./config.js";
    import { classifyTask } from "./route.js";
    import { formatHookOutput } from "./hook.js";
    async function main() {
      let input = "";
      for await (const chunk of process.stdin) input += chunk;
      const event: unknown = JSON.parse(input);
      if (typeof event !== "object" || event === null ||
          !("hook_event_name" in event) || event.hook_event_name !== "UserPromptSubmit" ||
          !("prompt" in event) || typeof event.prompt !== "string")
        throw new Error("invalid hook event");
      const output = formatHookOutput(await classifyTask(event.prompt, loadConfig()));
      if (output) process.stdout.write(JSON.stringify(output) + "\n");
    }
    main().catch(() => {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: "Turnhelm routing unavailable; check the real backend and configuration."
      }) + "\n");
      process.exitCode = 0;
    });
    ~~~

    Replace package.json's bin map with the following; do not install it globally yet:

    ~~~json
    "bin": {
      "turnhelm": "./dist/src/cli.js",
      "turnhelm-hook": "./dist/src/hook-entry.js"
    }
    ~~~

- [ ] **Step 5: Add inactive examples/hooks.json.** It is not loaded until the user explicitly copies it to .codex/hooks.json in a trusted repository:

    ~~~json
    {
      "hooks": {
        "UserPromptSubmit": [{
          "hooks": [{
            "type": "command",
            "command": "node \"$(git rev-parse --show-toplevel)/dist/src/hook-entry.js\"",
            "timeout": 5,
            "additionalContextLimit": 200
          }]
        }]
      }
    }
    ~~~

- [ ] **Step 6: Verify the real hook adapter without TUI.** Build, then use a synthetic UserPromptSubmit event while the selected real Laya or Jev backend is available:

    ~~~sh
    npm run build
    printf '%s\n' '{"hook_event_name":"UserPromptSubmit","prompt":"Rename the README heading only."}' |
      TURNHELM_CONFIG="$PWD/.turnhelm-live.json" node dist/src/hook-entry.js
    ~~~

    Confirm JSON output has the expected fixed developer context or explicit block; no backend stub or recorded response is used. Append this native-TUI pilot note to README.md:

    ~~~markdown
    ## Native TUI pilot

    examples/hooks.json is inactive until copied to a trusted repository's
    .codex/hooks.json and explicitly trusted through /hooks. It asks the
    unchanged main Codex thread to delegate coding tasks to one subagent.
    The main thread's model does not switch. Hook execution and delegation are
    not guaranteed enforcement boundaries; verify actual child settings in
    a real TUI trial before relying on this path. Local Laya is recommended
    for this trial. A TYPESAFE_API_KEY or LAYA_API_KEY exported to the native
    TUI environment may be visible to Codex-launched tools.
    ~~~

    Run npm test && npm audit --audit-level=high && git diff --check; review and commit as feat(hook): request routed subagent delegation.

### Task 5: Native TUI pilot and go/no-go evidence

**Files:**
- Create only after real trial: docs/validation/2026-09-30-routing-trial.md
- Modify: README.md if the trial reveals a documented operational constraint
- User-managed local test file: .codex/hooks.json (ignored by git)

**Interfaces:**
- Consumes: built hook entry and a running real selected backend.
- Produces: a written go/no-go report based on the native TUI's actual subagent behavior, not a simulated session.

- [ ] **Step 1: Ask for explicit approval before activating the project-local hook.** After approval, run mkdir -p .codex && cp examples/hooks.json .codex/hooks.json, run npm run build, export TURNHELM_CONFIG="$PWD/.turnhelm-live.json", open native codex in this repository, inspect /hooks, and trust the exact hook definition. Do not bypass hook trust.

- [ ] **Step 2: Run three real TUI scenarios.** Submit one safe read-only coding request, one non-coding status request, and the short continuation 继续. Inspect the child via the native agent view and its status. Record the effective child model and effort, one-child count, any direct parent work, any recursive hook invocation, approval prompts, and failures. If the effective model/effort cannot be verified, mark the B trial inconclusive.

- [ ] **Step 3: Compare performance with an un-routed native-TUI baseline.** Record each trial's time to child start, total completion time, and token use. Use the real 24-call/backend p50/p95 output from Task 2 for classification latency. Do not fabricate percentiles from only three TUI prompts or assert savings without comparison.

- [ ] **Step 4: Stop on an unsupported boundary.** If UserPromptSubmit also runs on child prompts with no documented root discriminator, a custom agent file overrides the requested model/effort, the parent skips delegation, or the hook is not trusted/loaded, do not promote B. State which condition failed and keep Phase A available.

- [ ] **Step 5: Write the evidence report and request the user's go/no-go decision.** The report must contain exact commands, backend names, Codex version, synthetic prompts, observed route IDs, child effective model/effort, timings, token counts, and limitations. Redact keys and do not paste raw private prompts. Commit only the report and README corrections after git diff --check and npm audit --audit-level=high. Do not install a user-level hook or retire A without an explicit go decision.

### Task 6: Complete the A-to-B transition only after a go decision

**Files:**
- Modify: src/cli.ts, README.md
- Delete: src/codex.ts, test/codex.test.ts after B is verified in a second repository
- Keep: src/config.ts, src/systemone.ts, src/route.ts, src/hook.ts, src/hook-entry.ts
- User-managed only: remove this repository's ignored .codex/hooks.json trial file and merge a hook entry into ~/.codex/hooks.json without replacing other hooks

**Interfaces:**
- The supported CLI becomes turnhelm route "<task>" for diagnostics; the native TUI hook owns automatic execution. No duplicate automatic route path remains.

- [ ] **Step 1: Confirm the user approved B in the Task 5 report.** If not, stop here; leave A intact.
- [ ] **Step 2: Obtain separate approval for global activation.** Only after approval, install a built snapshot rather than linking the mutable development directory. Run the following in Turnhelm, then ask the user to merge the UserPromptSubmit handler below into their existing ~/.codex/hooks.json without overwriting any other hook:

    ~~~sh
    mkdir -p "$HOME/.config/turnhelm"
    test ! -e "$HOME/.config/turnhelm/config.json" || { echo "Review the existing Turnhelm config before replacing it" >&2; exit 1; }
    cp .turnhelm-live.json "$HOME/.config/turnhelm/config.json"
    unset TURNHELM_CONFIG
    npm test
    npm audit --audit-level=high
    npm pack --pack-destination /tmp
    npm install -g /tmp/turnhelm-0.0.0.tgz
    test ! -e .codex/hooks.json.turnhelm-trial-backup || { echo "Trial hook backup already exists" >&2; exit 1; }
    mv .codex/hooks.json .codex/hooks.json.turnhelm-trial-backup
    ~~~

    ~~~json
    {
      "UserPromptSubmit": [{
        "hooks": [{
          "type": "command",
          "command": "turnhelm-hook",
          "timeout": 5,
          "additionalContextLimit": 200
        }]
      }]
    }
    ~~~

    The snippet is the value to merge under the existing top-level hooks object, not a replacement for the entire file. If hooks.json does not exist, wrap this value under a new top-level hooks object. Inspect existing UserPromptSubmit handlers first: if Turnhelm is already registered or another router would issue competing delegation instructions, stop and resolve that conflict. Do not invoke the Phase A turnhelm codex command while the global hook is active; that would route twice during the short transition. Do not change ~/.codex/config.toml or auth data.

- [ ] **Step 3: Verify global behavior in a second trusted repository before removing A.** Run mkdir -p /tmp/turnhelm-tui-trial && git -C /tmp/turnhelm-tui-trial init, then start native codex from that directory. Inspect /hooks, trust the user-level handler, and run one synthetic coding task and one non-coding question. Confirm no project-local Turnhelm hook remains active, one child has the requested effective model/effort, and no child appears for the question. If any check fails, ask the user to disable the user-level hook and keep A; do not continue.

- [ ] **Step 4: Write a failing CLI test that codex is no longer an accepted command.** Create test/transition.test.ts; before the change, the current CLI prints its generic routing error rather than the required route-only usage.

    ~~~ts
    import test from "node:test";
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { fileURLToPath } from "node:url";
    test("codex command is retired after TUI promotion", () => {
      const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
      const result = spawnSync(process.execPath, [cli, "codex", "ignored"], { encoding: "utf8" });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /usage: turnhelm route/);
    });
    ~~~

    Run npm test and observe the expected failure.

- [ ] **Step 5: Remove only the Phase A exec path, its unused helper and its test.** Delete src/codex.ts and test/codex.test.ts, and replace src/cli.ts with this route-only entry. Keep the shared classifier and Hook. In README.md, remove the Phase A execution command instructions and retain turnhelm route as diagnostic. State in its Supported interface section: "Run native codex with a reviewed Turnhelm UserPromptSubmit hook. The main thread keeps its model; selected coding tasks run in one model/effort-specific subagent."

    ~~~ts
    #!/usr/bin/env node
    import { loadConfig } from "./config.js";
    import { classifyTask } from "./route.js";
    async function main() {
      const [command, ...rest] = process.argv.slice(2);
      const prompt = rest.join(" ").trim();
      if (command !== "route" || !prompt) {
        console.error('usage: turnhelm route "<task>"');
        process.exitCode = 2;
        return;
      }
      const decision = await classifyTask(prompt, loadConfig());
      console.log(JSON.stringify(decision));
    }
    main().catch(() => {
      console.error("Turnhelm could not route this task; check config and backend availability.");
      process.exitCode = 1;
    });
    ~~~
- [ ] **Step 6: Run npm test, npm run test:live against real Laya and Jev, npm audit --audit-level=high, and git diff --check.** Check that both live backends are still real and passing; review the diff; commit as refactor(cli): retire one-shot execution after TUI trial.

## Source references

- [OpenAI Docs: Codex hooks](https://learn.chatgpt.com/docs/hooks)
- [OpenAI Docs: subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [OpenAI Docs: non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [TypeSafe Jev OpenAPI](https://api.typesafe.ai/openapi.json)
- [Laya published package and serve instructions](https://pypi.org/project/laya/)
