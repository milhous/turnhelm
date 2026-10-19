#!/usr/bin/env node
import { discoverWorkerCredential, executeWorker, type WorkerResult } from "./codex.js";
import { readProjectConfig } from "./config.js";
import { doctorProject } from "./doctor.js";
import { initProject } from "./init.js";
import { validateOutputSchema } from "./output-schema.js";
import { appendLifecycleEvent, appendRouteJournal } from "./journal.js";
import { LifecycleRecorder } from "./lifecycle.js";
import { inspectCodex, inspectGit } from "./preflight.js";
import { resolveProject } from "./project.js";
import { isSupportedNode, MIN_NODE_VERSION } from "./runtime.js";
import { routeTask } from "./route.js";
import { eligibleBackends } from "./systemone.js";
import { readTask } from "./task.js";

class UsageError extends Error {}

type Command =
  | { command: "init"; project?: string; dryRun: boolean }
  | { command: "doctor"; project?: string; json: boolean; probe: boolean }
  | { command: "run"; project?: string; write: boolean; lifecycle: boolean; outputSchema?: string; stallAbortMs?: number; task?: string };

const USAGE =
  'usage: turnhelm init [--dry-run] [--project <dir>] | '
  + 'turnhelm doctor [--json] [--probe] [--project <dir>] | '
  + 'turnhelm run [--write] [--lifecycle] [--project <dir>] [--output-schema <file>] [--stall-abort-ms <ms>] [--] [<task>]';

const parse = (argv: readonly string[]): Command => {
  const [command, ...rest] = argv;
  const allowed = command === "init" ? ["--project", "--dry-run"]
    : command === "doctor" ? ["--project", "--json", "--probe"]
    : ["--project", "--write", "--output-schema", "--lifecycle", "--stall-abort-ms"];
  if (command !== "init" && command !== "doctor" && command !== "run") throw new UsageError(USAGE);
  let project: string | undefined;
  let outputSchema: string | undefined;
  let stallAbortMs: number | undefined;
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
      if (name === "--project" || name === "--output-schema" || name === "--stall-abort-ms") {
        const value = equals === -1 ? rest[++index] : arg.slice(equals + 1);
        if (value === undefined || value === "") throw new UsageError(USAGE);
        if (name === "--project") project = value;
        else if (name === "--output-schema") outputSchema = value;
        else {
          // Same bounds as a roster deadlineMs: a real integer window, never a
          // free-form duration.
          const ms = Number(value);
          if (!Number.isInteger(ms) || ms < 5000 || ms > 3600000) throw new UsageError(USAGE);
          stallAbortMs = ms;
        }
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
  return { command, project, write: seen.has("--write"), lifecycle: seen.has("--lifecycle"), outputSchema, stallAbortMs, task };
};

const diagnostic = (message: string): void => {
  console.error("turnhelm: " + message);
};

const signalExit = (signal: "SIGINT" | "SIGTERM" | undefined): number => {
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGINT") return 130;
  return 1;
};

// The caller's signal owns the exit code when received; without one, a
// controlled transport/protocol/spawn failure exits 1 even when the child
// happened to exit zero, and a natural worker exit status stands.
const workerExit = (worker: WorkerResult, signal: "SIGINT" | "SIGTERM" | undefined): number => {
  if (signal !== undefined) return signalExit(signal);
  if (worker.status === "completed") return 0;
  if (worker.error !== undefined && worker.error !== "worker") return 1;
  if (worker.code > 0) return worker.code;
  return 1;
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
  // Doctor owns its operation like run does: a received parent signal aborts
  // the bounded inspections and probes through the controller, so the owned
  // groups are stopped instead of orphaned by a default-disposition death.
  const controller = new AbortController();
  let signal: "SIGINT" | "SIGTERM" | undefined;
  const onSignal = (received: NodeJS.Signals): void => {
    signal = received === "SIGTERM" ? "SIGTERM" : "SIGINT";
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    // Probe mode alone dials, through the shared default request chain; a
    // plain doctor never sends a request and creates no network Agent.
    const result = await doctorProject(root, { probe, env: process.env, signal: controller.signal });
    if (json) {
      console.log(JSON.stringify(result));
    } else {
      for (const check of result.checks) {
        console.error("turnhelm doctor: [" + check.status + "] " + check.id + ": " + check.evidence
          + (check.next === "" ? "" : " (next: " + check.next + ")"));
      }
    }
    return signal !== undefined ? signalExit(signal) : result.code;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
};

const runCommand = async (root: string, write: boolean, positionalTask: string | undefined, outputSchema?: string, lifecycle = false, stallAbortMs?: number): Promise<number> => {
  // Recursion is rejected before any configuration read or classification.
  if (process.env.TURNHELM_MANAGED_CHILD === "1") {
    diagnostic("this process is a Turnhelm-managed child; run must not recurse. Execute the task directly.");
    return 1;
  }
  // One snapshot for the whole run: preflight, eligibility, routing, and the
  // worker all see the environment as it was before classification, following
  // the config/executable snapshot pattern.
  const env: NodeJS.ProcessEnv = { ...process.env };
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
    // OC-1: schema validation sits at the input boundary with the task — a
    // rejection is a usage error before any configuration read or spend.
    let schemaBytes: Buffer | undefined;
    if (outputSchema !== undefined) {
      const schema = validateOutputSchema(outputSchema);
      if ("error" in schema) {
        diagnostic(schema.error);
        return 2;
      }
      schemaBytes = schema.bytes;
    }
    let config;
    try {
      config = await readProjectConfig(root);
    } catch {
      diagnostic(".turnhelm/config.json is missing or not a valid v2 project config; run turnhelm init.");
      return 1;
    }
    const [codex, git] = await Promise.all([
      inspectCodex(root, env, controller.signal),
      inspectGit(root, env, controller.signal)
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
    if (eligibleBackends(config, env).length === 0) {
      diagnostic("no eligible classification backend; enable one in .turnhelm/config.json and provide its credentials.");
      return 1;
    }
    // WB-2: pre-spend credential refusal — a worker with no discoverable
    // credential source is rejected here, before any classification request.
    if (discoverWorkerCredential(env) === undefined) {
      diagnostic("no worker credential is discoverable; provide a CODEX_HOME auth.json or export OPENAI_API_KEY.");
      return 1;
    }
    // Classification starts here; exactly one receipt is emitted below.
    const routing = await routeTask(task, config, { env, signal: controller.signal });
    // Evidence for routing decisions is journaled best-effort before the worker;
    // a journaling failure never blocks the run itself.
    await appendRouteJournal(root, task, routing, diagnostic);
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
      worker: { status: "not-started", durationMs: 0, progressEvents: 0, usage: "unreported" },
      // CU-1: the bounded Laya token-fact projection when one validated;
      // the literal otherwise. Evidence, never a gate.
      classifierUsage: routing.status === "selected" && routing.decision.classifierUsage !== undefined
        ? routing.decision.classifierUsage
        : "unreported",
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
      // EV-1: opt-in lifecycle evidence — the bounded ring plus one best-effort
      // journal line per event; without the flag nothing records or journals.
      const recorder = lifecycle
        ? new LifecycleRecorder(event => { void appendLifecycleEvent(root, { pid: process.pid, ...event }, diagnostic); })
        : undefined;
      const worker = await executeWorker(decision, task, {
        executable: codex.executable,
        root,
        write,
        ...(schemaBytes !== undefined ? { schemaBytes } : {}),
        env,
        signal: controller.signal,
        output: process.stdout,
        diagnostics: process.stderr,
        ...(recorder !== undefined ? { lifecycle: recorder } : {}),
        ...(stallAbortMs !== undefined ? { stallAbortMs } : {})
      });
      // Missing usage is explicitly unreported, never zero or omitted.
      const workerReceipt: Record<string, unknown> = {
        status: worker.status,
        code: worker.code,
        durationMs: worker.durationMs,
        progressEvents: worker.progressEvents,
        usage: worker.usage ?? "unreported",
        // Required boolean: an action record (a parent-initiated ladder ran),
        // never a causation claim. False on natural paths.
        ownedShutdown: worker.ownedShutdown
      };
      if (worker.lastEventAgeMs !== undefined) workerReceipt.lastEventAgeMs = worker.lastEventAgeMs;
      // WB-4: the managed-home attestation rides executed-worker receipts only.
      if (worker.codexHomeManaged === true) workerReceipt.codexHomeManaged = true;
      // The fixed note's version tag rides the same executed-worker paths;
      // absent means no note was appended (spec §3.2).
      if (worker.instructionNote !== undefined) workerReceipt.instructionNote = worker.instructionNote;
      // The stall watchdog's reason, iff it fired (spec §3.3).
      if (worker.abortReason !== undefined) workerReceipt.abortReason = worker.abortReason;
      if (worker.signal !== undefined) workerReceipt.signal = worker.signal;
      if (worker.failureClass !== undefined) workerReceipt.failureClass = worker.failureClass;
      if (worker.errorSha256 !== undefined) workerReceipt.errorSha256 = worker.errorSha256;
      if (worker.payload !== undefined) workerReceipt.payload = worker.payload;
      if (worker.lifecycle !== undefined) workerReceipt.lifecycle = worker.lifecycle;
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
  // The runtime floor is checked before any command dispatch: no task input,
  // tool inspection, or project write happens on an unsupported Node.
  if (!isSupportedNode()) {
    diagnostic("node " + MIN_NODE_VERSION.join(".") + " or newer is required; this runtime is unsupported and no command ran.");
    return 1;
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
  return runCommand(root, command.write, command.task, command.outputSchema, command.lifecycle, command.stallAbortMs);
};

main().then(code => {
  process.exitCode = code;
}, () => {
  diagnostic("unexpected internal failure.");
  process.exitCode = 1;
});
