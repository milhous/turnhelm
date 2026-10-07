import { spawn } from "node:child_process";
import { decodeWorkerEvent, MAX_EVENT_BYTES, type WorkerEvent, type WorkerUsage } from "./codex-events.js";
import type { RouteDecision, TaskDecision } from "./route.js";

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
  let processFailed = false;
  child.once("error", () => { processFailed = true; });
  if (!child.stdin) throw new Error("Codex could not start");
  const stdin = child.stdin;
  return await new Promise<number>((resolve, reject) => {
    let inputFailed = false;
    stdin.on("error", () => { inputFailed = true; });
    // close follows stdio shutdown, including pending stdin errors.
    child.once("close", code => {
      if (processFailed) reject(new Error("Codex could not start"));
      else resolve(code === 0 && inputFailed ? 1 : (code ?? 1));
    });
    stdin.end(prompt);
  });
}

export type WorkerResult = Readonly<{
  code: number;
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  usage?: WorkerUsage;
  usageScope: "unverified";
  error?: "spawn" | "stdin" | "protocol" | "output" | "worker";
}>;

export function buildWorkerArgs(decision: TaskDecision, write: boolean): string[] {
  return ["exec", "--ephemeral", "--json", "--sandbox", write ? "workspace-write" : "read-only",
    "--config", "agents.enabled=false", "--model", decision.profile.model,
    "--config", `model_reasoning_effort=${JSON.stringify(decision.profile.effort)}`, "-"];
}

export function subprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.LAYA_API_KEY;
  delete copy.TYPESAFE_API_KEY;
  delete copy.TURNHELM_ALLOW_HOSTED_JEV;
  delete copy.TURNHELM_CONFIG;
  return copy;
}

export function workerEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...subprocessEnvironment(env), TURNHELM_MANAGED_CHILD: "1" };
}

const TERM_GRACE_MS = 1000;
const GROUP_POLL_MS = 25;

const exitStatus = (code: number | null, signal: NodeJS.Signals | null): number => {
  if (code !== null) return code;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (signal === "SIGKILL") return 137;
  return 1;
};

export function executeWorker(
  decision: TaskDecision,
  task: string,
  options: {
    executable: string;
    root: string;
    write: boolean;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    output: NodeJS.WritableStream;
    diagnostics?: NodeJS.WritableStream;
  }
): Promise<WorkerResult> {
  const started = performance.now();
  if (options.signal?.aborted) {
    return Promise.resolve({ code: -1, status: "cancelled", durationMs: 0, usageScope: "unverified" });
  }
  return new Promise<WorkerResult>(resolve => {
    const child = spawn(options.executable, buildWorkerArgs(decision, options.write), {
      shell: false,
      cwd: options.root,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: workerEnvironment(options.env)
    });
    const output = options.output;
    const diagnostics = options.diagnostics ?? process.stderr;
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    let failure: WorkerResult["error"] | undefined;
    let cancelled = false;
    let stickyFailed = false;
    let completionSeen = false;
    let usage: WorkerUsage | undefined;
    let inputDelivered = false;
    let childCode: number | null = null;
    let childSignal: NodeJS.Signals | null = null;
    let closed = false;
    let finished = false;
    let shutdownStarted = false;
    let shutdownDischarged = true;
    let pollTimer: NodeJS.Timeout | undefined;
    let frame: Buffer = Buffer.alloc(0);
    let cancelDrainWait: (() => void) | undefined;
    let cancelDiagWait: (() => void) | undefined;
    let diagLine: string | undefined;
    let stdoutEnded = false;
    let pendingOutputs = 0;

    // The diagnostics sink is owned output: an async sink error or close is a
    // parent-output failure with the same EPIPE discipline as the message sink.
    const onDiagFailure = (): void => { recordFailure("output"); };
    diagnostics.on("error", onDiagFailure);
    diagnostics.on("close", onDiagFailure);

    // A nonempty unfinished frame at EOF is a protocol error, but frames still
    // awaiting a backpressure drain are not a tail; the check waits for the sink.
    const checkFinalTail = (): void => {
      if (stdoutEnded && cancelDrainWait === undefined && !finished && !shutdownStarted && frame.length > 0) {
        recordFailure("protocol");
      }
    };

    // Only this child's owned group is ever a target; ESRCH means it is already gone.
    const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
      const id = child.pid;
      if (id === undefined) return false;
      try {
        process.kill(-id, signal);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };

    const stopStdin = (): void => {
      try { stdin?.destroy(); } catch { /* Teardown must not mask the failure cause. */ }
    };

    const finish = (): void => {
      if (finished) return;
      finished = true;
      options.signal?.removeEventListener("abort", onAbort);
      // With writes still in flight the listeners stay attached (they detach
      // from the last write callback); cancellation may settle despite them.
      if (pendingOutputs === 0) detachSinkListeners();
      cancelDrainWait?.();
      cancelDiagWait?.();
      let status: WorkerResult["status"];
      let error: WorkerResult["error"];
      if (failure !== undefined) { status = "failed"; error = failure; }
      else if (cancelled) { status = "cancelled"; error = undefined; }
      else if (!inputDelivered) { status = "failed"; error = "stdin"; }
      else if (childCode !== 0 || !completionSeen || stickyFailed) { status = "failed"; error = "worker"; }
      else { status = "completed"; error = undefined; }
      const result = {
        code: exitStatus(childCode, childSignal),
        status,
        durationMs: Math.round(performance.now() - started),
        usageScope: "unverified"
      } as { code: number; status: WorkerResult["status"]; durationMs: number; usageScope: "unverified"; usage?: WorkerUsage; error?: WorkerResult["error"] };
      if (usage) result.usage = usage;
      if (error) result.error = error;
      resolve(result);
    };

    // Settling requires the child close, the bounded group-shutdown obligation,
    // and an empty message pipeline. An accepted write that has neither
    // completed nor errored holds settlement open — an accepted write is not a
    // flushed write — unless cancellation resolves the run.
    const settle = (): void => {
      if (!closed || finished || !shutdownDischarged || cancelDrainWait !== undefined) return;
      if (pendingOutputs !== 0 && !cancelled) return;
      finish();
    };

    const dischargeShutdown = (): void => {
      if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
      shutdownDischarged = true;
      settle();
    };

    // TERM the owned group now, then KILL within the grace if it remains. A leader
    // exit never discharges this obligation while owned descendants stay alive.
    const beginShutdown = (): void => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      cancelDrainWait?.();
      cancelDiagWait?.();
      stopStdin();
      if (child.pid === undefined) { settle(); return; }
      shutdownDischarged = false;
      signalGroup("SIGTERM");
      const shutdownAt = performance.now();
      pollTimer = setInterval(() => {
        if (!signalGroup(0)) { dischargeShutdown(); return; }
        if (performance.now() - shutdownAt >= TERM_GRACE_MS) {
          signalGroup("SIGKILL");
          dischargeShutdown();
        }
      }, GROUP_POLL_MS);
    };

    // The first transport cause wins; consequences of our own shutdown are not
    // causes, and nothing after settlement changes the reported outcome.
    const recordFailure = (cause: "spawn" | "stdin" | "protocol" | "output"): void => {
      if (failure !== undefined || shutdownStarted || finished) return;
      failure = cause;
      beginShutdown();
    };

    const onAbort = (): void => { cancelled = true; beginShutdown(); };
    const onOutputError = (): void => { recordFailure("output"); };

    // Listener lifetime must cover our accepted bytes: while any write this
    // invocation made is still in flight, the sinks keep their error listeners,
    // so a late sink error can never be an unhandled emission.
    const detachSinkListeners = (): void => {
      output.removeListener("error", onOutputError);
      diagnostics.removeListener("error", onDiagFailure);
      diagnostics.removeListener("close", onDiagFailure);
    };

    // Completion or error of every accepted write, on both sinks.
    const onWriteAck = (error?: Error | null): void => {
      pendingOutputs -= 1;
      if (error !== null && error !== undefined) { recordFailure("output"); return; }
      if (finished) {
        if (pendingOutputs === 0) detachSinkListeners();
        return;
      }
      settle();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Early spawn-error listener precedes any stdin use (same pattern as runCodex).
    child.once("error", () => { recordFailure("spawn"); });
    output.on("error", onOutputError);

    const waitForDrain = (): (() => void) => {
      let settledWait = false;
      const onDrain = (): void => completeWait(false);
      const onFailed = (): void => completeWait(true);
      const completeWait = (failed: boolean): void => {
        if (settledWait) return;
        settledWait = true;
        output.removeListener("drain", onDrain);
        output.removeListener("error", onFailed);
        output.removeListener("close", onFailed);
        cancelDrainWait = undefined;
        if (failed) { recordFailure("output"); return; }
        stdout.resume();
        if (!shutdownStarted && !finished) processFrames();
      };
      output.once("drain", onDrain);
      output.once("error", onFailed);
      output.once("close", onFailed);
      return () => completeWait(false);
    };

    const emitMessage = (text: string): void => {
      pendingOutputs += 1;
      let accepted: boolean;
      try {
        accepted = output.write(text + "\n", onWriteAck);
      } catch {
        pendingOutputs -= 1;
        recordFailure("output");
        return;
      }
      if (accepted) return;
      // The sink may have aborted, errored, or closed synchronously inside
      // write(); once shutdown owns the outcome a fresh blocked drain wait
      // would be unreachable and could never be cancelled.
      if (shutdownStarted || finished) return;
      stdout.pause();
      cancelDrainWait = waitForDrain();
    };

    const waitDiagDrain = (): (() => void) => {
      let settledWait = false;
      const onDrain = (): void => completeWait(false);
      const onFailed = (): void => completeWait(true);
      const completeWait = (failed: boolean): void => {
        if (settledWait) return;
        settledWait = true;
        diagnostics.removeListener("drain", onDrain);
        diagnostics.removeListener("error", onFailed);
        diagnostics.removeListener("close", onFailed);
        cancelDiagWait = undefined;
        if (failed) { recordFailure("output"); return; }
        const line = diagLine;
        diagLine = undefined;
        if (line !== undefined && !shutdownStarted && !finished) writeDiagLine(line);
      };
      diagnostics.once("drain", onDrain);
      diagnostics.once("error", onFailed);
      diagnostics.once("close", onFailed);
      return () => completeWait(false);
    };

    const writeDiagLine = (line: string): void => {
      pendingOutputs += 1;
      let accepted: boolean;
      try {
        accepted = diagnostics.write(line, onWriteAck);
      } catch {
        pendingOutputs -= 1;
        recordFailure("output");
        return;
      }
      if (accepted) return;
      // The sink may have aborted, errored, or closed synchronously inside
      // write(); a blocked wait after shutdown would be unreachable. A false
      // return means the line was ACCEPTED (queued), never that it was
      // rejected: only a NEW event arriving while blocked may occupy the
      // lossy slot, so the drain never replays this line.
      if (shutdownStarted || finished) return;
      cancelDiagWait = waitDiagDrain();
    };

    // One fixed-category line per diagnostic event; never the raw command,
    // output, stderr, or native error text behind it. While the sink is
    // blocked, at most the latest new event's line is retained — the queue
    // cannot grow with the event count, and accepted lines are never rewritten.
    const reportDiagnostic = (category: "worker-event-error" | "tool-progress"): void => {
      if (shutdownStarted || finished) return;
      const line = "turnhelm: " + category + "\n";
      if (cancelDiagWait !== undefined) { diagLine = line; return; }
      writeDiagLine(line);
    };

    const dispatch = (event: WorkerEvent): void => {
      switch (event.kind) {
        case "message":
          emitMessage(event.text);
          return;
        case "completed":
          completionSeen = true;
          // Latest valid snapshot replaces; absent or empty usage keeps the earlier one.
          if (event.usage) usage = event.usage;
          return;
        case "failed":
          // Irreversible: a later completion cannot restore success.
          stickyFailed = true;
          beginShutdown();
          return;
        case "diagnostic":
          reportDiagnostic(event.category);
          return;
        default:
          return; // Unknown well-formed events are ignored.
      }
    };

    const processFrames = (): void => {
      while (!finished && !shutdownStarted) {
        const index = frame.indexOf(0x0a);
        if (index < 0) {
          if (frame.length > MAX_EVENT_BYTES) recordFailure("protocol");
          break;
        }
        const completeFrame = frame.subarray(0, index);
        frame = frame.subarray(index + 1);
        if (completeFrame.length > MAX_EVENT_BYTES) { recordFailure("protocol"); return; }
        let event: WorkerEvent;
        try {
          event = decodeWorkerEvent(completeFrame);
        } catch {
          recordFailure("protocol");
          return;
        }
        dispatch(event);
        if (cancelDrainWait !== undefined) return; // Sink blocked; the drain resumes the loop.
      }
      // The child may have closed while buffered messages were still draining.
      checkFinalTail();
      settle();
    };

    if (!stdin || !stdout || !stderr) {
      // All three descriptors are configured for this spawn; a missing one is a start failure.
      recordFailure("spawn");
    } else {
      stdin.on("error", () => { recordFailure("stdin"); });
      stdin.end(task, (error?: Error | null) => { if (!error) inputDelivered = true; });
      stderr.on("error", () => { /* Drained and discarded; never stalls stdout. */ });
      stderr.resume();
      stdout.on("data", (chunk: Buffer) => {
        frame = frame.length === 0 ? chunk : Buffer.concat([frame, chunk]);
        processFrames();
      });
      stdout.once("end", () => {
        stdoutEnded = true;
        checkFinalTail();
        settle();
      });
      stdout.on("error", () => { recordFailure("output"); });
    }

    child.once("close", (code, signal) => {
      closed = true;
      childCode = code;
      childSignal = signal;
      settle();
    });
  });
}
