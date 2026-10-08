import { readFileSync } from "node:fs";
import { parseProjectConfig, type ProjectConfig } from "../src/config.js";

export function fixtureConfig(): ProjectConfig {
  return parseProjectConfig(JSON.parse(readFileSync(new URL("../../assets/config.json", import.meta.url), "utf8")));
}

export function decisionReply(choice = "fast"): unknown {
  return { answers: { route: { type: "choice", choice } } };
}

export const fakeEnv: NodeJS.ProcessEnv = {
  LAYA_API_KEY: "TEST_LAYA_SENTINEL", TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
  TURNHELM_ALLOW_HOSTED_JEV: "1"
};
