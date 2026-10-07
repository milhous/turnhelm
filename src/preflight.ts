import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { subprocessEnvironment } from "./codex.js";

export type Inspection = Readonly<{ ok: boolean; executable?: string; version?: string; controls?: readonly string[] }>;

const TIMEOUT_MS = 2000;
const CAP_BYTES = 64 * 1024;
const MIN_VERSION: readonly [number, number, number] = [0, 160, 0];
const REQUIRED_CONTROLS: readonly string[] = ["--json", "--ephemeral", "--sandbox", "-"];

type RunOutcome = {
  code: number | null;
  stdout: string;
  stderr: string;
  failure?: "timeout" | "overflow" | "cancelled" | "spawn" | "signalled";
};

function resolveExecutable(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const path = env.PATH ?? env.Path;
  if (typeof path !== "string" || path === "") return undefined;
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return undefined;
}

// Bounded, non-shell subprocess run: pipes are drained with hard caps, the
// child is killed and drained on timeout, overflow, or caller cancellation,
// and no raw output escapes to callers.
function runBounded(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<RunOutcome> {
  return new Promise(resolve => {
    const settle = (outcome: RunOutcome): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    let failure: RunOutcome["failure"];
    const child = spawn(executable, [...args], {
      shell: false,
      cwd: options.cwd,
      detached: true, // Own process group so a waiting sh cannot defer the kill.
      stdio: ["ignore", "pipe", "pipe"],
      env: options.env
    });
    const killChild = (): void => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try { child.kill(); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      failure = "timeout";
      killChild();
    }, TIMEOUT_MS);
    const onAbort = (): void => {
      failure = "cancelled";
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => {
      failure = "spawn";
    });
    const collect = (stream: "stdout" | "stderr"): Buffer[] => {
      const chunks: Buffer[] = [];
      let total = 0;
      child[stream].on("data", (chunk: Buffer) => {
        if (failure === "overflow") return; // Keep draining; the cap is already tripped.
        total += chunk.length;
        if (total > CAP_BYTES) {
          failure = "overflow";
          killChild();
          return;
        }
        chunks.push(chunk);
      });
      child[stream].on("error", () => {
        if (failure === undefined) failure = "spawn";
      });
      return chunks;
    };
    const outChunks = collect("stdout");
    const errChunks = collect("stderr");
    child.once("close", code => {
      if (failure === undefined && code === null) failure = "signalled";
      settle({
        code,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        failure
      });
    });
  });
}

function versionTuple(text: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(tuple: readonly number[], floor: readonly number[]): boolean {
  for (let index = 0; index < floor.length; index++) {
    if (tuple[index] !== floor[index]) return (tuple[index] ?? 0) > floor[index];
  }
  return true;
}

function inspect(executable: string, args: readonly string[], root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<RunOutcome> {
  if (signal?.aborted) {
    return Promise.resolve({ code: null, stdout: "", stderr: "", failure: "cancelled" });
  }
  return runBounded(executable, args, { cwd: root, env: subprocessEnvironment(env), signal });
}

export async function inspectCodex(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Inspection> {
  const executable = resolveExecutable("codex", env);
  if (executable === undefined) return { ok: false };
  const version = await inspect(executable, ["--version"], root, env, signal);
  if (version.failure !== undefined || version.code !== 0) return { ok: false, executable };
  const tuple = versionTuple(version.stdout);
  if (tuple === undefined) return { ok: false, executable };
  const reported = tuple.join(".");
  const help = await inspect(executable, ["exec", "--help"], root, env, signal);
  if (help.failure !== undefined || help.code !== 0) return { ok: false, executable, version: reported };
  const controls = REQUIRED_CONTROLS.filter(control => control === "-"
    ? /(^|\s)-(\s|$)/.test(help.stdout)
    : help.stdout.includes(control));
  return {
    ok: atLeast(tuple, MIN_VERSION) && controls.length === REQUIRED_CONTROLS.length,
    executable,
    version: reported,
    controls
  };
}

export async function inspectGit(root: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Inspection> {
  const executable = resolveExecutable("git", env);
  if (executable === undefined) return { ok: false };
  const run = await inspect(executable, ["-C", root, "rev-parse", "--is-inside-work-tree"], root, env, signal);
  return { ok: run.failure === undefined && run.code === 0 && run.stdout.trim() === "true", executable };
}
