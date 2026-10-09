import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PREPARE = "--turnhelm-fixture-prepare";
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

// Exported only for controlled broken-launcher lifecycle tests.
export function prepareExecutable(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, [PREPARE], { detached: true, stdio: "ignore" });
    let failure: Error | undefined;
    let closeGuard: NodeJS.Timeout | undefined;
    let cleanupDone = false;
    const killOwned = (): void => {
      if (child.pid === undefined || cleanupDone) return;
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      cleanupDone = true;
    };
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      clearTimeout(closeGuard);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      try { killOwned(); } catch (cleanupError) { error = cleanupError as Error; }
      if (error) reject(error); else resolve();
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(failure ?? (code === 0 ? undefined : new Error(`fixture preparation exited ${code ?? signal}`)));
    };
    const timer = setTimeout(() => {
      failure = new Error("fixture preparation timed out");
      try { killOwned(); } catch (error) { finish(error as Error); return; }
      closeGuard = setTimeout(() => finish(failure), 1000);
    }, 10_000);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

// Shell $0 names the sidecar; Node retains argv[1], env, __dirname and PID.
export async function executableFixture(path: string, body: string, kind: "node" | "shell"): Promise<void> {
  // ponytail: Node shebang paths cannot contain whitespace; use a native launcher if needed.
  if (kind === "node" && /\s/.test(process.execPath)) throw new Error("whitespace in Node interpreter path is unsupported");
  path = resolve(path);
  const payload = path + (kind === "node" ? ".cjs" : ".sh");
  await writeFile(payload, body, { mode: 0o600, flag: "wx" });
  const launcher = kind === "node"
    ? `#!${process.execPath}\nif (process.argv.length === 3 && process.argv[2] === ${JSON.stringify(PREPARE)}) process.exit(0);\nrequire(${JSON.stringify(payload)});\n`
    : `#!/bin/sh\nif [ "$#" -eq 1 ] && [ "$1" = '${PREPARE}' ]; then exit 0; fi\nexec /bin/sh ${quote(payload)} "$@"\n`;
  await writeFile(path, launcher, { mode: 0o700, flag: "wx" });
  await prepareExecutable(path);
}
