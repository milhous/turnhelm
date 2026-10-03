#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { runCodex } from "./codex.js";
import { resolvePhaseARoute } from "./route.js";

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const write = command === "codex" && rest[0] === "--write";
  const prompt = (write ? rest.slice(1) : rest).join(" ");
  if (!["codex", "route"].includes(command ?? "") || !prompt.trim()) {
    throw new Error('usage: turnhelm codex [--write] "<task>" | turnhelm route "<task>"');
  }
  const decision = await resolvePhaseARoute(prompt, loadConfig());
  if (command === "route") {
    console.log(JSON.stringify(decision));
    return;
  }
  process.exitCode = await runCodex(decision, prompt, write);
}

main().catch(() => {
  console.error("Turnhelm could not route this task; check config and backend availability.");
  process.exitCode = 1;
});
