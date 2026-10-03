import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig, parseConfig } from "../src/config.js";
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

// Smoke coverage only: six labelled bilingual cases, repeated four times (24 calls per backend).
for (const backend of ["laya", "jev"] as const) {
  test("real " + backend + " routes labelled prompts", async () => {
    if (backend === "jev" && process.env.TURNHELM_ALLOW_HOSTED_JEV !== "1") {
      throw new Error("real jev live test requires TURNHELM_ALLOW_HOSTED_JEV=1");
    }
    const base = loadConfig();
    const config = parseConfig({
      ...base,
      backend,
      ...(backend === "jev" ? { hostedJev: { enabled: true } } : {})
    });
    const times: number[] = [];
    for (let repeat = 0; repeat < 4; repeat++) {
      for (const [prompt, expected] of cases) {
        const start = performance.now();
        const result = await classifyTask(prompt, config);
        times.push(performance.now() - start);
        assert.equal(result.kind === "direct" ? "direct" : result.profileId, expected);
      }
    }
    console.info(backend + " calls=24 p50_ms=" + percentile(times, 0.5).toFixed(1) + " p95_ms=" + percentile(times, 0.95).toFixed(1));
  });
}
