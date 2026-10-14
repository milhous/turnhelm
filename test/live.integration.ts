// Live acceptance entry: strict argument grammar over the test-only harness.
// prepare is offline; execute spends only what the claimed manifest reserves.
// Exit codes: 2 illegal input, 1 failure or incomplete run, 0 complete pass,
// 130/143 on SIGINT/SIGTERM. Exactly one forwarding separator is tolerated.
import { executeAcceptance, prepareAcceptance, type LiveSuite, type PrepareAcceptanceOptions } from "./live-acceptance.js";

class UsageError extends Error {}

const USAGE = "usage: node dist/test/live.integration.js --prepare laya|jev|dual|calibration-dev|calibration-holdout [--config <file>] [--case dual-jev-write] | --execute <manifest.json> --approve <sha256>";

type Args =
  | { command: "prepare"; suite: LiveSuite; configPath?: string; caseId?: "dual-jev-write" }
  | { command: "execute"; manifest: string; approved: string };

const HEX64 = /^[0-9a-f]{64}$/;

const parseArgs = (argv: readonly string[]): Args => {
  const args = argv.slice();
  if (args[0] === "--") args.shift();
  if (args.includes("--")) throw new UsageError("only one forwarding separator is allowed");
  if (args[0] === "--prepare") {
    const suite = args[1];
    if (suite !== "laya" && suite !== "jev" && suite !== "dual"
      && suite !== "calibration-dev" && suite !== "calibration-holdout") throw new UsageError("unknown suite");
    // Strict prepare options: each flag at most once, a value always present,
    // and the case selector only for the existing dual fallback case.
    const flags = new Map<string, string>();
    for (let index = 2; index < args.length; index += 2) {
      const flag = args[index];
      if (flag !== "--config" && flag !== "--case") throw new UsageError("unknown prepare option");
      if (flags.has(flag)) throw new UsageError("duplicate prepare option");
      if (args[index + 1] === undefined) throw new UsageError("missing prepare option value");
      flags.set(flag, args[index + 1] as string);
    }
    const configPath = flags.get("--config");
    const caseId = flags.get("--case");
    if (caseId !== undefined) {
      if (caseId !== "dual-jev-write") throw new UsageError("unknown prepare case");
      if (suite !== "dual") throw new UsageError("the case selector selects an existing dual fallback case");
    }
    return {
      command: "prepare", suite,
      ...(configPath !== undefined ? { configPath } : {}),
      ...(caseId !== undefined ? { caseId: caseId as "dual-jev-write" } : {})
    };
  }
  if (args.length === 4 && args[0] === "--execute" && args[2] === "--approve") {
    if (!HEX64.test(args[3])) throw new UsageError("the approved hash must be 64 lowercase hex characters");
    return { command: "execute", manifest: args[1], approved: args[3] };
  }
  throw new UsageError("unknown arguments");
};

const main = async (): Promise<number> => {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(USAGE);
    return 2;
  }
  if (args.command === "prepare") {
    try {
      const options: PrepareAcceptanceOptions = {
        ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
        ...(args.caseId !== undefined ? { caseId: args.caseId } : {})
      };
      const prepared = await prepareAcceptance(args.suite, options);
      process.stdout.write(`manifest ${prepared.manifestPath}\n`);
      process.stdout.write(`sha256 ${prepared.sha256}\n`);
      return 0;
    } catch (error) {
      console.error("prepare failed: " + (error instanceof Error ? error.message : "unknown failure"));
      return 1;
    }
  }
  const controller = new AbortController();
  let received: "SIGINT" | "SIGTERM" | undefined;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (received !== undefined) {
      // A second signal re-raises the default disposition: the operator's
      // escape hatch from a run that will not wind down.
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.kill(process.pid, signal);
      return;
    }
    received = signal === "SIGTERM" ? "SIGTERM" : "SIGINT";
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const code = await executeAcceptance(args.manifest, args.approved, { signal: controller.signal });
    return received !== undefined ? (received === "SIGTERM" ? 143 : 130) : code;
  } catch (error) {
    console.error("execute failed: " + (error instanceof Error ? error.message : "unknown failure"));
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
};

main().then(code => {
  process.exitCode = code;
}).catch(() => {
  // An unexpected entry-level throw still fails the run, never a rejection dump.
  process.exitCode = 1;
});
