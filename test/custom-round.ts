// Runner-owned sandboxed check launcher for custom rounds (spec §3.2(2)):
// contract and oracle checks run under the frozen sandbox policy through a
// wrapper whose single marked outcome line replaces exit-code and stderr
// inference. Everything with a failure mode here is runner-owned — the round
// input never supplies code on this path.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { oracleSandboxPolicy } from "./live-acceptance.js";

export type CheckOutcome =
  | { status: "pass" }
  | { status: "failed" }
  | { status: "infrastructure"; reason: "spawn-error" | "signal" | "timeout" | "missing-outcome" };

// The wrapper the runner ships into every check: importing the entry IS the
// check — a thrown error is the assertion failure — and only this wrapper
// prints the marked line, exiting immediately after so no pending entry timer
// can print a forged marker behind it.
export const CHECK_WRAPPER_SOURCE = `import { pathToFileURL } from "node:url";
const [entry] = process.argv.slice(2);
try {
  await import(pathToFileURL(entry).href);
  process.stdout.write("__TURNHELM_CHECK_OUTCOME__" + JSON.stringify({ pass: true }) + "\\n");
} catch {
  process.stdout.write("__TURNHELM_CHECK_OUTCOME__" + JSON.stringify({ pass: false }) + "\\n");
}
process.exit(0);
`;

const CHECK_MARKER = "__TURNHELM_CHECK_OUTCOME__";
const STDOUT_CAP_BYTES = 1 << 20;
const TERM_GRACE_MS = 2000;

export async function runSandboxedCheck(options: {
  sandboxExecPath: string;
  runtimeDir: string;
  cwd: string;
  entryScript: string;
  allowReadSubpaths: readonly string[];
  timeoutMs: number;
}): Promise<CheckOutcome> {
  const nonce = randomBytes(12).toString("hex");
  const profilePath = join(options.runtimeDir, `check-profile-${nonce}.sb`);
  const wrapperPath = join(options.runtimeDir, `check-wrapper-${nonce}.mjs`);
  // Policy bytes exist only for this invocation: generated in memory, written
  // to a launcher-managed temp file, deleted in the finally below — nothing
  // persists to go stale and no byte-equality tautology is possible. The
  // child's cwd and the node installation are readable by construction: node
  // cannot even boot without its cwd (the v0.3.0 EPERM uv_cwd crash shape),
  // and a package-manager node's dyld closure spans its whole install prefix
  // (homebrew resolves into a Cellar tree whose dylibs live in sibling formula
  // dirs like /opt/homebrew/opt/llhttp) — reachable only by walking ancestors,
  // because process.execPath may already be the realpath, not the shim.
  // ponytail: ancestor depth 5 covers homebrew Cellar/<name>/<ver>/bin/node
  // and nvm versions/node/<ver>/bin/node; a deeper layout adds its prefix via
  // allowReadSubpaths. SBPL subpaths match literally, so every readable path
  // is canonicalized first — a symlinked prefix (/tmp, /var) would otherwise
  // never match its kernel-resolved form (/private/tmp, /private/var).
  const nodeReal = await realpath(process.execPath);
  const nodeClosure: string[] = [];
  for (const start of new Set([process.execPath, nodeReal])) {
    for (let path = dirname(start), depth = 0; depth < 5 && path !== dirname(path); path = dirname(path), depth++) {
      nodeClosure.push(path);
    }
  }
  await writeFile(profilePath, oracleSandboxPolicy({
    runtimeDir: await realpath(options.runtimeDir),
    allowReadSubpaths: await Promise.all([...new Set([
      options.cwd,
      ...nodeClosure,
      ...options.allowReadSubpaths
    ])].map(path => realpath(path)))
  }), { mode: 0o600 });
  await writeFile(wrapperPath, CHECK_WRAPPER_SOURCE, { mode: 0o600 });
  try {
    return await new Promise<CheckOutcome>(resolve => {
      // The sealed round's fresh allowlist env (business-run.mjs contract()):
      // the check's credential boundary is what this env carries, not what
      // the sandbox hides.
      const env = {
        PATH: dirname(process.execPath) + ":/usr/bin:/bin",
        HOME: options.cwd,
        ZDOTDIR: join(options.cwd, ".turnhelm"),
        TMPDIR: options.cwd,
        LANG: "C",
        TZ: "UTC"
      };
      const child = spawn(options.sandboxExecPath,
        ["-f", profilePath, process.execPath, wrapperPath, options.entryScript],
        { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stdoutCapped = false;
      let spawnErrored = false;
      let timedOut = false;
      let resolved = false;
      const timers: NodeJS.Timeout[] = [];
      const finish = (outcome: CheckOutcome): void => {
        if (resolved) return;
        resolved = true;
        for (const timer of timers) clearTimeout(timer);
        resolve(outcome);
      };
      // An explicit outcome record is graded normally; a spawn error, death
      // signal, timeout, or any exit without a usable final marker is an
      // integrity stop. Nothing is inferred from exit code alone.
      const classify = (signal: NodeJS.Signals | null): CheckOutcome => {
        if (spawnErrored) return { status: "infrastructure", reason: "spawn-error" };
        if (timedOut) return { status: "infrastructure", reason: "timeout" };
        if (signal !== null) return { status: "infrastructure", reason: "signal" };
        // Only the final marked line counts: a forged marker printed mid-run
        // cannot outrank the wrapper's last word. A capped buffer cannot
        // prove which marker was final, so it fails closed.
        if (stdoutCapped) return { status: "infrastructure", reason: "missing-outcome" };
        const last = stdout.map(chunk => chunk.toString("utf8")).join("")
          .split("\n").filter(line => line.startsWith(CHECK_MARKER)).at(-1);
        if (last === undefined) return { status: "infrastructure", reason: "missing-outcome" };
        try {
          const parsed: unknown = JSON.parse(last.slice(CHECK_MARKER.length));
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
          const record = parsed as Record<string, unknown>;
          if (Object.keys(record).length !== 1 || (record.pass !== true && record.pass !== false)) {
            throw new Error("shape");
          }
          return record.pass ? { status: "pass" } : { status: "failed" };
        } catch {
          return { status: "infrastructure", reason: "missing-outcome" };
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > STDOUT_CAP_BYTES) {
          stdoutCapped = true;
          return;
        }
        stdout.push(chunk);
      });
      // Stderr is drained and discarded: classification never reads it.
      child.stderr.on("data", () => {});
      child.on("error", () => {
        spawnErrored = true;
        finish({ status: "infrastructure", reason: "spawn-error" });
      });
      child.on("close", (_code, signal) => finish(classify(signal)));
      timers.push(setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        timers.push(setTimeout(() => child.kill("SIGKILL"), TERM_GRACE_MS));
      }, options.timeoutMs));
    });
  } finally {
    await rm(profilePath, { force: true });
    await rm(wrapperPath, { force: true });
  }
}
