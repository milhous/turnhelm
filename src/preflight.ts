import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { subprocessEnvironment } from "./codex.js";

export type Inspection = Readonly<{ ok: boolean; executable?: string; version?: string; controls?: readonly string[] }>;

const TIMEOUT_MS = 2000;
const TERM_GRACE_MS = 250;
const CLOSE_BOUND_MS = 2000;
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
      // E9: the chosen entry is pinned as an absolute caller-frame path so a
      // later cwd change (the inspection runs in the project) can never
      // re-resolve a relative entry to a different project's binary.
      return resolve(candidate);
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return undefined;
}

// Bounded, non-shell subprocess run: pipes are drained with hard caps, the
// whole process group is killed (TERM, then SIGKILL escalation) and close is
// awaited only boundedly on timeout, overflow, or caller cancellation — even
// when the leader has already exited and a TERM-ignoring descendant holds the
// pipes — and no raw output escapes to callers.
function runBounded(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<RunOutcome> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        cwd: options.cwd,
        detached: true, // Own process group so a waiting sh cannot defer the kill.
        stdio: ["ignore", "pipe", "pipe"],
        env: options.env
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", failure: "spawn" });
      return;
    }
    let failure: RunOutcome["failure"];
    let exitCode: number | null = null;
    let settled = false;
    let killInitiated = false;
    const timers: NodeJS.Timeout[] = [];
    const later = (fn: () => void, ms: number): void => {
      timers.push(setTimeout(fn, ms));
    };
    const collect = (stream: "stdout" | "stderr"): Buffer[] => {
      const chunks: Buffer[] = [];
      let total = 0;
      const pipe = child[stream];
      if (pipe === null) return chunks;
      pipe.on("data", (chunk: Buffer) => {
        if (failure === "overflow") return; // Keep draining; the cap is already tripped.
        total += chunk.length;
        if (total > CAP_BYTES) {
          failure = "overflow";
          killChild();
          return;
        }
        chunks.push(chunk);
      });
      pipe.on("error", () => {
        if (failure === undefined) failure = "spawn";
      });
      return chunks;
    };
    const outChunks = collect("stdout");
    const errChunks = collect("stderr");
    const settle = (): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        code: exitCode,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        failure
      });
    };
    // The group kill reaches every member, including a TERM-ignoring
    // descendant that survives the leader while holding the pipes open.
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // The group is already gone; nothing left to bound.
      }
    };
    const killChild = (): void => {
      if (child.pid === undefined || killInitiated) return;
      killInitiated = true;
      killGroup("SIGTERM");
      // Some group members trap or ignore TERM: escalate, and never wait for
      // close unboundedly even then.
      later(() => killGroup("SIGKILL"), TERM_GRACE_MS);
      later(settle, TERM_GRACE_MS + CLOSE_BOUND_MS);
    };
    const onAbort = (): void => {
      failure = "cancelled";
      killChild();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    later(() => {
      failure = "timeout";
      killChild();
    }, TIMEOUT_MS);
    child.once("error", () => {
      if (failure === undefined) failure = "spawn";
      later(settle, CLOSE_BOUND_MS); // A spawn failure may never reach close on its own.
    });
    child.once("close", code => {
      if (failure === undefined && code === null) failure = "signalled";
      exitCode = code;
      // E12: the leader's pipes closing does not discharge the owned group —
      // a same-group descendant with stdio:ignore holds no pipes and would
      // otherwise outlive the settled inspection. Owned non-inference
      // children are killed outright; the bounded TERM-escalate path above
      // still covers the inherited-pipe/ignore/overflow/cancel cases.
      killGroup("SIGKILL");
      settle();
    });
  });
}

// E2: only anchored, well-formed `codex-cli <major>.<minor>.<patch>` output
// counts as version evidence. Each component is capped at three digits so the
// numeric compare never sees unsafe counters, and an unrecognized suffix such
// as a prerelease tag can never slip through an incidental substring match.
const VERSION_PATTERN = /^codex-cli (\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/;

function versionTuple(text: string): readonly [number, number, number] | undefined {
  const match = VERSION_PATTERN.exec(text.trim());
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
  // E3: each required control must appear as an exact whitespace-delimited
  // token, so unrelated strings sharing a prefix never satisfy a control;
  // agents.enabled semantics are still never inferred from generic --config help.
  const tokens = new Set(help.stdout.split(/\s+/));
  const controls = REQUIRED_CONTROLS.filter(control => tokens.has(control));
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
