import test from "node:test";
import assert from "node:assert/strict";
import { readProjectConfig } from "../src/config.js";
import { routeTask } from "../src/route.js";

// This file is intentionally excluded from `pnpm test`; `pnpm run test:live`
// is an explicit real-service gate. It never probes or qualifies models:
// routeTask's selected profile IDs are the only routing outcomes, and usage
// totals stay unverified. Compile-only for offline verification.

const cases = [
  ["What is this repository called? Do not change files.", "fast"],
  ["这个项目叫什么？只回答，不改文件。", "fast"],
  ["Rename the README heading to Turnhelm; change only that line.", "fast"],
  ["把 README 的标题改成 Turnhelm，只改这一行。", "fast"],
  ["Investigate a worker/database race, fix it, and add regression tests.", "deep"],
  ["审查认证流程中的权限提升和令牌泄漏风险，并给出证据。", "frontier_max"]
] as const;

const percentile = (values: number[], p: number) => values.sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

for (const backend of ["laya", "jev"] as const) {
  test("real " + backend + " routes labelled prompts through the project entry", async () => {
    if (backend === "jev" && process.env.TURNHELM_ALLOW_HOSTED_JEV !== "1") {
      throw new Error("real jev live test requires TURNHELM_ALLOW_HOSTED_JEV=1");
    }
    const config = await readProjectConfig(process.cwd());
    const env = backend === "jev"
      ? { ...process.env, TURNHELM_ALLOW_HOSTED_JEV: "1" }
      : process.env;
    const times: number[] = [];
    const selected = new Map<string, number>();
    for (let repeat = 0; repeat < 4; repeat++) {
      for (const [prompt, expected] of cases) {
        const start = performance.now();
        const result = await routeTask(prompt, config, { env });
        times.push(performance.now() - start);
        assert.equal(result.status, "selected");
        assert.equal(result.decision.profileId, expected);
        selected.set(expected, (selected.get(expected) ?? 0) + 1);
      }
    }
    console.info(backend + " calls=24 selected_profiles="
      + ["fast", "deep", "frontier_max"].map((id) => id + ":" + (selected.get(id) ?? 0)).join(",")
      + " p50_ms=" + percentile(times, 0.5).toFixed(1)
      + " p95_ms=" + percentile(times, 0.95).toFixed(1)
      + " usage_scope=unverified");
  });
}
