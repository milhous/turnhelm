#!/usr/bin/env node
import { executeWorker, type WorkerResult } from "./codex.js";
import { readProjectConfig } from "./config.js";
import { doctorProject } from "./doctor.js";
import { initProject } from "./init.js";
import { inspectCodex, inspectGit } from "./preflight.js";
import { resolveProject } from "./project.js";
import { routeTask } from "./route.js";
import { eligibleBackends } from "./systemone.js";
import { readTask } from "./task.js";

class UsageError extends Error {}

type Command =
  | { command: "init"; project?: string; dryRun: boolean }
  | { command: "doctor"; project?: string; json: boolean; probe: boolean }
  | { command: "run"; project?: string; write: boolean; task?: string };

const USAGE =
  'usage: turnhelm init [--dry-run] [--project <dir>] | '
  + 'turnhelm doctor [--json] [--probe] [--project <dir>] | '
  + 'turnhelm run [--write] [--project <dir>] [--] [<task>]';

const parse = (argv: readonly string[]): Command => {
  const [command, ...rest] = argv;
  const allowed = command === "init" ? ["--project", "--dry-run"]
    : command === "doctor" ? ["--project", "--json", "--probe"]
    : ["--project", "--write"];
  if (command !== "init" && command !== "doctor" && command !== "run") throw new UsageError(USAGE);
  let project: string | undefined;
  let task: string | undefined;
  let positional = false;
  let escaped = false;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!escaped && arg === "--") {
      escaped = true;
      continue;
    }
    if (!escaped && arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (!allowed.includes(name)) throw new UsageError(USAGE);
      if (seen.has(name)) throw new UsageError(USAGE);
      seen.add(name);
      if (name === "--project") {
        const value = equals === -1 ? rest[++index] : arg.slice(equals + 1);
        if (value === undefined || value === "") throw new UsageError(USAGE);
        project = value;
      } else if (equals !== -1) {
        throw new UsageError(USAGE);
      }
      continue;
    }
    if (command !== "run" || positional) throw new UsageError(USAGE);
    positional = true;
    task = arg;
  }
  // "--" exists only to introduce one option-like task token.
  if (escaped && !positional) throw new UsageError(USAGE);
  if (command === "init") return { command, project, dryRun: seen.has("--dry-run") };
  if (command === "doctor") return { command, project, json: seen.has("--json"), probe: seen.has("--probe") };
  return { command, project, write: seen.has("--write"), task };
};

const diagnostic = (message: string): void => {
  console.error("turnhelm: " + message);
};

const signalExit = (signal: "SIGINT" | "SIGTERM" | undefined): number => {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  return 1;
};

// Controlled transport/protocol/spawn failures exit 1 even when the child
// happened to exit zero; otherwise the worker's own exit status stands.
const workerExit = (worker: WorkerResult, signal: "SIGINT" | "SIGTERM" | undefined): number => {
  if (worker.status === "completed") return 0;
  if (worker.error !== undefined && worker.error !== "worker") return 1;
  if (worker.code > 0) return worker.code;
  return signalExit(signal);
};

const initCommand = async (root: string, dryRun: boolean): Promise<number> => {
  const result = await initProject(root, { dryRun });
  if (dryRun) {
    for (const path of result.planned) console.error("turnhelm init: planned " + path);
    if (result.code !== 0) diagnostic("init dry-run could not inspect this project; review the reported conflict.");
    else if (result.planned.length === 0) console.error("turnhelm init: nothing to install; this project is already initialized.");
  } else {
    for (const path of result.applied) console.error("turnhelm init: applied " + path);
    if (result.code !== 0) diagnostic("installation stopped early; review the retained files reported above.");
  }
  console.error("turnhelm init: restart any existing Codex session in this project to load the installed instructions.");
  return result.code;
};

const doctorCommand = async (root: string, json: boolean, probe: boolean): Promise<number> => {
  const result = await doctorProject(root, { probe, env: process.env });
  if (json) {
    console.log(JSON.stringify(result));
    return result.code;
  }
  for (const check of result.checks) {
    console.error("turnhelm doctor: [" + check.status + "] " + check.id + ": " + check.evidence
      + (check.next === "" ? "" : " (next: " + check.next + ")"));
  }
  return result.code;
};

const runCommand = async (root: string, write: boolean, positionalTask: string | undefined): Promise<number> => {
  // Recursion is rejected before any configuration read or classification.
  if (process.env.TURNHELM_MANAGED_CHILD === "1") {
    diagnostic("this process is a Turnhelm-managed child; run must not recurse. Execute the task directly.");
    return 1;
  }
  const controller = new AbortController();
  let signal: "SIGINT" | "SIGTERM" | undefined;
  const onSignal = (received: NodeJS.Signals): void => {
    signal = received === "SIGTERM" ? "SIGTERM" : "SIGINT";
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    let task: string;
    try {
      task = await readTask(positionalTask, process.stdin, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        diagnostic("cancelled while waiting for task input.");
        return signalExit(signal);
      }
      // Fixed validator wording; never task content.
      diagnostic(error instanceof Error ? error.message : "the task input is invalid.");
      return 2;
    }
    // The TTY fast path never touches stdin; release it so the run can end.
    // A redirected-file stdin is an fs.ReadStream without unref and needs none.
    if (typeof (process.stdin as { unref?: unknown }).unref === "function") process.stdin.unref();
    let config;
    try {
      config = await readProjectConfig(root);
    } catch {
      diagnostic(".turnhelm/config.json is missing or not a valid v1 project config; run turnhelm init.");
      return 1;
    }
    const [codex, git] = await Promise.all([
      inspectCodex(root, process.env, controller.signal),
      inspectGit(root, process.env, controller.signal)
    ]);
    if (controller.signal.aborted) {
      diagnostic("cancelled before classification.");
      return signalExit(signal);
    }
    if (!codex.ok || codex.executable === undefined) {
      diagnostic("no compatible Codex executable was found; codex 0.160.0+ with --json, --ephemeral, --sandbox, and stdin is required.");
      return 1;
    }
    if (!git.ok) {
      diagnostic("the project root is not inside a Git work tree (or git is unavailable); a Git work tree is required for run.");
      return 1;
    }
    if (eligibleBackends(config, process.env).length === 0) {
      diagnostic("no eligible classification backend; enable one in .turnhelm/config.json and provide its credentials.");
      return 1;
    }
    // Classification starts here; exactly one receipt is emitted below.
    const routing = await routeTask(task, config, { env: process.env, signal: controller.signal });
    const attempts = routing.status === "selected" ? routing.decision.attempts : routing.attempts;
    const routingMs = routing.status === "selected" ? routing.decision.routingMs : routing.routingMs;
    const counts: Record<string, number> = { laya: 0, jev: 0 };
    for (const attempt of attempts) counts[attempt.backend] += 1;
    const receipt: Record<string, unknown> = {
      type: "turnhelm.receipt",
      root,
      routing: {
        status: routing.status,
        routingMs,
        attempts,
        requestCounts: counts
      },
      worker: { status: "not-started" },
      classifierUsage: "unreported",
      wholeRunUsageScope: "unverified"
    };
    let exitCode: number;
    if (routing.status === "selected") {
      const decision = routing.decision;
      receipt.selection = {
        backend: decision.backend,
        profileId: decision.profileId,
        model: decision.profile.model,
        effort: decision.profile.effort
      };
      const worker = await executeWorker(decision, task, {
        executable: codex.executable,
        root,
        write,
        env: process.env,
        signal: controller.signal,
        output: process.stdout,
        diagnostics: process.stderr
      });
      const workerReceipt: Record<string, unknown> = {
        status: worker.status,
        code: worker.code,
        durationMs: worker.durationMs
      };
      if (worker.usage !== undefined) workerReceipt.usage = worker.usage;
      receipt.worker = workerReceipt;
      exitCode = workerExit(worker, signal);
    } else {
      exitCode = routing.status === "cancelled" ? signalExit(signal) : 1;
    }
    console.error(JSON.stringify(receipt));
    return exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
};

const main = async (): Promise<number> => {
  let command: Command;
  try {
    command = parse(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    diagnostic(error.message);
    return 2;
  }
  let root: string;
  try {
    root = resolveProject(command.project);
  } catch {
    diagnostic("could not resolve the project root" + (command.project ? " " + JSON.stringify(command.project) : "") + ".");
    return 1;
  }
  if (command.command === "init") return initCommand(root, command.dryRun);
  if (command.command === "doctor") return doctorCommand(root, command.json, command.probe);
  return runCommand(root, command.write, command.task);
};

main().then(code => {
  process.exitCode = code;
}, () => {
  diagnostic("unexpected internal failure.");
  process.exitCode = 1;
});
