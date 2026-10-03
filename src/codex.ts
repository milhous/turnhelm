import { spawn } from "node:child_process";
import type { RouteDecision } from "./route.js";

export function buildCodexArgs(route: RouteDecision, write: boolean): string[] {
  const args = ["exec", "--sandbox", write ? "workspace-write" : "read-only"];
  if (route.kind === "profile") {
    args.push("--model", route.profile.model, "--config", `model_reasoning_effort="${route.profile.effort}"`);
  }
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
  const child = spawn("codex", buildCodexArgs(route, write), {
    shell: false,
    stdio: ["pipe", "inherit", "inherit"],
    env: codexEnvironment()
  });
  if (!child.stdin) throw new Error("Codex stdin unavailable");
  const stdin = child.stdin;
  return await new Promise<number>((resolve, reject) => {
    let inputFailed = false;
    let processFailed = false;
    child.once("error", () => { processFailed = true; });
    stdin.on("error", () => { inputFailed = true; });
    // close follows stdio shutdown, including pending stdin errors.
    child.once("close", code => {
      if (processFailed) reject(new Error("Codex could not start"));
      else resolve(code === 0 && inputFailed ? 1 : (code ?? 1));
    });
    stdin.end(prompt);
  });
}
