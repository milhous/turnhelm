import { spawn } from "node:child_process";
import { accessSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeWorkerEvent, MAX_EVENT_BYTES, type FailureClass, type WorkerEvent, type WorkerUsage } from "./codex-events.js";
import type { LifecycleEvent, LifecycleRecorder } from "./lifecycle.js";
import { classifyPayload, type PayloadMode } from "./payload.js";
import type { TaskDecision } from "./route.js";

export type WorkerResult = Readonly<{
  code: number;
  status: "completed" | "failed" | "cancelled";
  durationMs: number;
  // Parent-observed decoded-event evidence: the count of successfully decoded
  // events of all kinds, and the rounded age from the last decode to
  // settlement (present iff the count is positive). Never a liveness or stall
  // claim — backpressure and the shutdown grace both bound what the age proves.
  progressEvents: number;
  lastEventAgeMs?: number;
  usage?: WorkerUsage;
  usageScope: "unverified";
  error?: "spawn" | "stdin" | "protocol" | "output" | "worker";
  // The child's observed death signal; an action record of a parent-initiated
  // group shutdown (ownedShutdown), never a claim about the child's cause.
  signal?: "SIGINT" | "SIGTERM" | "SIGKILL";
  ownedShutdown: boolean;
  // WB-4: present iff this run actually executed — the worker ran under a
  // per-run managed CODEX_HOME destroyed at settlement. An attestation of that
  // mechanism, never a universal instruction-isolation claim.
  codexHomeManaged?: true;
  failureClass?: FailureClass;
  errorSha256?: string;
  // PE-1: the emission classifier's bounded, content-free projection, attached
  // iff the run completed and emission was initiated. A failed or cancelled run
  // — including a cancellation that lands mid-write after bytes were delivered —
  // carries none; those receipts already tell that story.
  payload?: Readonly<{ mode: PayloadMode; trailerBytes?: number }>;
  // EV-1: the bounded content-free lifecycle ring, attached iff a recorder was
  // supplied — never worker output, task text, or error prose. Parent-observed
  // milestones only; thread correlation is deliberately absent.
  lifecycle?: Readonly<{ events: readonly LifecycleEvent[]; overflow: boolean }>;
}>;

export function buildWorkerArgs(decision: TaskDecision, write: boolean, schemaPath?: string): string[] {
  return ["exec", "--ephemeral", "--json",
    // WB-1: instruction-context isolation by argv — the worker starts from the
    // task alone, never host codex config or discovered rules files.
    "--ignore-user-config", "--ignore-rules",
    "--sandbox", write ? "workspace-write" : "read-only",
    "--config", "agents.enabled=false", "--model", decision.profile.model,
    "--config", `model_reasoning_effort=${JSON.stringify(decision.profile.effort)}`,
    // OC-1: the schema path is the staged copy inside the managed home —
    // present only when validated bytes were supplied, never the caller's path.
    ...(schemaPath === undefined ? [] : ["--output-schema", schemaPath]), "-"];
}

export function subprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.LAYA_API_KEY;
  delete copy.TYPESAFE_API_KEY;
  delete copy.TURNHELM_ALLOW_HOSTED_JEV;
  delete copy.TURNHELM_CONFIG;
  // A non-interactive bash (or POSIX-shell) descendant sources these at
  // startup, re-importing stripped material the same way zsh's startup files
  // did before the ZDOTDIR redirect.
  delete copy.BASH_ENV;
  delete copy.ENV;
  // Coverage instrumentation belongs to this process, not to the external worker
  // binary; forwarding it lets test-spawned children write into the shared
  // coverage directory where a killed child leaves a truncated file behind.
  // Node reinserts the parent's NODE_V8_COVERAGE into any child env lacking
  // this own property, so deletion is not stripping: an explicit undefined is.
  copy.NODE_V8_COVERAGE = undefined;
  return copy;
}

export function workerEnvironment(env: NodeJS.ProcessEnv, homeDir: string): NodeJS.ProcessEnv {
  return {
    ...subprocessEnvironment(env),
    TURNHELM_MANAGED_CHILD: "1",
    // WB-2: the worker's CODEX_HOME is this run's managed home; whatever the
    // parent carried is overridden and never reaches the child.
    CODEX_HOME: homeDir,
    // HOME-derived discovery (startup files, $HOME/.agents, dotfiles) resolves
    // inside the managed home and dies with the run. Scoped closure only:
    // explicit override variables (XDG_*, GIT_CONFIG_GLOBAL, …) and system
    // files still pass through as documented residuals.
    HOME: homeDir,
    // zsh sources $ZDOTDIR/.zshenv even non-interactively, falling back to HOME,
    // which let host startup files re-export stripped keys into worker
    // descendants. Pointing ZDOTDIR at the managed home keeps those files out;
    // a missing startup file there is zsh's skip state, and a host-exported
    // ZDOTDIR must not win over the redirect.
    ZDOTDIR: homeDir
  };
}

// WB-2: the parent-derived credential source — the parent's CODEX_HOME when
// set, else ~/.codex/auth.json, resolved absolute so a relative home still
// links correctly from inside the managed directory. Only its existence is
// probed here; which credential mode backs it (file, keyring, in-memory) is
// not inferred.
function authSourcePath(env: NodeJS.ProcessEnv): string | undefined {
  const parentHome = env.CODEX_HOME;
  if (typeof parentHome === "string" && parentHome !== "") return resolve(parentHome, "auth.json");
  const home = env.HOME;
  if (typeof home === "string" && home !== "") return resolve(home, ".codex", "auth.json");
  return undefined;
}

// WB-2 (review P1-3): pre-spend credential discovery — which source, if any,
// a worker run could authenticate through: a regular file at the parent-
// derived source when one exists, else a nonblank OPENAI_API_KEY. Presence is
// probed, never read: this proves a source exists, never that it works.
export function discoverWorkerCredential(env: NodeJS.ProcessEnv): "file" | "key" | undefined {
  const source = authSourcePath(env);
  if (source !== undefined) {
    try {
      if (statSync(source).isFile()) return "file";
    } catch {
      // No file at the source; the exported key is the remaining source.
    }
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim() !== "") return "key";
  return undefined;
}

// WB-2: a fresh per-run home initialized with exactly what this run may see —
// an auth.json symlink to the parent-derived source when one exists, and the
// already-validated schema bytes staged as output-schema.json (the native
// runtime may add its own scratch). Setup is split by failure class: an
// absent credential source is the credential-free case, but any fault while
// building the home fails the run closed (the spawn class) with the partial
// home removed; an inherited home is never a fallback.
function createWorkerHome(env: NodeJS.ProcessEnv, schemaBytes?: Buffer): string | undefined {
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "turnhelm-worker-"));
  } catch {
    return undefined;
  }
  try {
    let source = authSourcePath(env);
    if (source !== undefined) {
      try {
        accessSync(source);
      } catch {
        // No credential file at the source: the home stays credential-free.
        source = undefined;
      }
    }
    if (source !== undefined) symlinkSync(source, join(dir, "auth.json"));
    if (schemaBytes !== undefined) writeFileSync(join(dir, "output-schema.json"), schemaBytes);
    return dir;
  } catch {
    destroyWorkerHome(dir);
    return undefined;
  }
}

// Settlement-scoped teardown: rmSync unlinks the credential symlink rather
// than following it — the real credential file is never this home's to
// remove. Best-effort by design; a cleanup failure never rewrites a settled
// run's outcome.
function destroyWorkerHome(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Nothing after settlement may fail the run. */ }
}

const TERM_GRACE_MS = 1000;
const GROUP_POLL_MS = 25;
const FAILED_EXIT_GRACE_MS = 5000;
const DEATH_SIGNALS: ReadonlySet<string> = new Set(["SIGINT", "SIGTERM", "SIGKILL"]);
const isDeathSignal = (signal: NodeJS.Signals): signal is "SIGINT" | "SIGTERM" | "SIGKILL" =>
  DEATH_SIGNALS.has(signal);

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
    schemaBytes?: Buffer;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    output: NodeJS.WritableStream;
    diagnostics?: NodeJS.WritableStream;
    lifecycle?: LifecycleRecorder;
  }
): Promise<WorkerResult> {
  const started = performance.now();
  if (options.signal?.aborted) {
    return Promise.resolve({ code: -1, status: "cancelled", durationMs: 0, progressEvents: 0, usageScope: "unverified", ownedShutdown: false });
  }
  // WB-2: the managed home exists before the child can, or the run never
  // starts — never under an inherited home.
  const managedHome = createWorkerHome(options.env, options.schemaBytes);
  if (managedHome === undefined) {
    return Promise.resolve({ code: 1, status: "failed", durationMs: Math.round(performance.now() - started),
      progressEvents: 0, usageScope: "unverified", ownedShutdown: false, error: "spawn", failureClass: "unknown" });
  }
  return new Promise<WorkerResult>(resolve => {
    // The IIFE keeps spawn's stdio-typed overload on the successful path while
    // converting a synchronous spawn fault to the spawn failure — never a
    // rejected promise that skips the receipt — with the managed home removed.
    const child = (() => {
      try {
        return spawn(options.executable, buildWorkerArgs(decision, options.write,
          options.schemaBytes === undefined ? undefined : join(managedHome, "output-schema.json")), {
          shell: false,
          cwd: options.root,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: workerEnvironment(options.env, managedHome)
        });
      } catch {
        return undefined;
      }
    })();
    if (child === undefined) {
      destroyWorkerHome(managedHome);
      resolve({ code: 1, status: "failed", durationMs: Math.round(performance.now() - started),
        progressEvents: 0, usageScope: "unverified", ownedShutdown: false, error: "spawn", failureClass: "unknown" });
      return;
    }
    options.lifecycle?.record("spawned", { pid: child.pid });
    const output = options.output;
    const diagnostics = options.diagnostics ?? process.stderr;
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    let failure: WorkerResult["error"] | undefined;
    let cancelled = false;
    let stickyFailed = false;
    let finalMessage: string | undefined;
    let finalEmitted = false;
    let payloadProjection: WorkerResult["payload"];
    let completionSeen = false;
    let decided = false;
    let progressEvents = 0;
    let lastEventAt: number | undefined;
    let usage: WorkerUsage | undefined;
    let inputDelivered = false;
    let childCode: number | null = null;
    let childSignal: NodeJS.Signals | null = null;
    let closed = false;
    let finished = false;
    let ownedShutdown = false;
    let failureClass: FailureClass | undefined;
    let failureHash: string | undefined;
    let failureDeadline: NodeJS.Timeout | undefined;
    let shutdownStarted = false;
    let shutdownDischarged = true;
    let pollTimer: NodeJS.Timeout | undefined;
    let frame: Buffer = Buffer.alloc(0);
    let cancelDrainWait: (() => void) | undefined;
    let cancelDiagWait: (() => void) | undefined;
    let diagLine: string | undefined;
    let stdoutEnded = false;
    const pendingWrites = { message: 0, diag: 0 };

    // The diagnostics sink is owned output: an async sink error or close is a
    // parent-output failure with the same EPIPE discipline as the message sink.
    const onDiagFailure = (): void => failSink("diag");
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

    // The shared completed-run predicate: settlement emission and the final
    // status decision compute eligibility once, from the same signals. The
    // process exit code is an observation, never a completion signal: after a
    // decoded terminal event the code only records how the group ended
    // (voluntarily, or under the owned ladder).
    const completedEligible = (): boolean =>
      failure === undefined && !cancelled && inputDelivered && completionSeen && !stickyFailed;

    const finish = (): void => {
      if (finished) return;
      finished = true;
      // WB-2: finish is reachable only past the child's close and the owned
      // group's discharge, so the managed home — and only it — goes now.
      destroyWorkerHome(managedHome);
      clearFailureDeadline();
      options.signal?.removeEventListener("abort", onAbort);
      // With writes still in flight the listeners stay attached (they detach
      // from the last write callback); cancellation may settle despite them.
      if (pendingWrites.message === 0 && pendingWrites.diag === 0) detachSinkListeners();
      cancelDrainWait?.();
      cancelDiagWait?.();
      let status: WorkerResult["status"];
      let error: WorkerResult["error"];
      if (failure !== undefined) { status = "failed"; error = failure; }
      else if (cancelled) { status = "cancelled"; error = undefined; }
      else if (!inputDelivered) { status = "failed"; error = "stdin"; }
      else if (!completedEligible()) { status = "failed"; error = "worker"; }
      else { status = "completed"; error = undefined; }
      const result = {
        code: exitStatus(childCode, childSignal),
        status,
        durationMs: Math.round(performance.now() - started),
        progressEvents,
        usageScope: "unverified"
      } as { code: number; status: WorkerResult["status"]; durationMs: number; progressEvents: number; usageScope: "unverified"; ownedShutdown: boolean; codexHomeManaged?: true; usage?: WorkerUsage; error?: WorkerResult["error"]; signal?: "SIGINT" | "SIGTERM" | "SIGKILL"; failureClass?: FailureClass; errorSha256?: string; lastEventAgeMs?: number; payload?: WorkerResult["payload"]; lifecycle?: WorkerResult["lifecycle"] };
      result.ownedShutdown = ownedShutdown;
      result.codexHomeManaged = true;
      if (lastEventAt !== undefined) result.lastEventAgeMs = Math.round(performance.now() - lastEventAt);
      if (usage) result.usage = usage;
      if (error) result.error = error;
      // A failed status always carries a class: an eventless failure is unknown.
      if (status === "failed") {
        result.failureClass = failureClass ?? "unknown";
        if (failureHash !== undefined) result.errorSha256 = failureHash;
      }
      if (childCode === null && childSignal !== null && isDeathSignal(childSignal)) {
        result.signal = childSignal;
      }
      // Attached iff completed and emission was initiated — finalEmitted is
      // that initiation record; a completed zero-message run never set it.
      if (status === "completed" && finalEmitted && payloadProjection !== undefined) result.payload = payloadProjection;
      // EV-1: settle is recorded last so the ring always ends at settlement.
      if (options.lifecycle !== undefined) {
        options.lifecycle.record("settle", { status });
        result.lifecycle = options.lifecycle.snapshot();
      }
      resolve(result);
    };

    // The once-only emission phase, shared by the terminal-event decision and
    // settlement: only a completed-eligible run with a retained final agent
    // message writes to stdout. PE-1: classification precedes the sink call so
    // the projection is captured before delivery; the sink receives the
    // classifier's text and keeps its single unconditional "\n" append.
    const emitFinalMessage = (): boolean => {
      if (finalEmitted || finalMessage === undefined || !completedEligible()) return false;
      finalEmitted = true; // Set before the sink call: ack re-entry must never re-emit.
      const classification = classifyPayload(finalMessage);
      payloadProjection = classification.trailerBytes === undefined
        ? { mode: classification.mode }
        : { mode: classification.mode, trailerBytes: classification.trailerBytes };
      emitMessage(classification.emittedText);
      return true;
    };

    // TS-1..TS-3: a decoded terminal event decides a clean run. The verdict is
    // emitted before any signal — while the ladder has not started, a sink
    // failure keeps its first-cause attribution — and the owned ladder then
    // bounds the exit wait that would otherwise be voluntary and unbounded.
    // The stdin end-callback is the second trigger: a terminal frame can be
    // decoded before inputDelivered lands, and without the re-check such a run
    // would never decide and the unbounded exit-wait would return.
    const tryDecide = (): void => {
      if (decided || shutdownStarted || finished) return;
      if (!completedEligible()) return;
      decided = true;
      emitFinalMessage();
      beginShutdown();
    };

    // Settling requires the child close, the bounded group-shutdown obligation,
    // and an empty message pipeline. An accepted write that has neither
    // completed nor errored holds settlement open — an accepted write is not a
    // flushed write — unless cancellation resolves the run.
    const settle = (): void => {
      if (!closed || finished || !shutdownDischarged || cancelDrainWait !== undefined) return;
      if ((pendingWrites.message !== 0 || pendingWrites.diag !== 0) && !cancelled) return;
      // The never-decided catch-all emission; a decided run already emitted.
      if (emitFinalMessage()) return; // The accepted write must flush (or fail) before the run finishes.
      finish();
    };

    const dischargeShutdown = (): void => {
      if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; }
      shutdownDischarged = true;
      options.lifecycle?.record("shutdown-discharged");
      settle();
    };

    // One bounded deadline from the first failure event: expiry discharges the
    // cleanup obligation unconditionally, regardless of leader liveness.
    const clearFailureDeadline = (): void => {
      if (failureDeadline !== undefined) { clearTimeout(failureDeadline); failureDeadline = undefined; }
    };
    const startFailureDeadline = (): void => {
      if (failureDeadline !== undefined || finished || shutdownStarted) return;
      failureDeadline = setTimeout(() => {
        failureDeadline = undefined;
        if (finished || shutdownStarted) return;
        beginShutdown();
      }, FAILED_EXIT_GRACE_MS);
    };

    // TERM the owned group now, then KILL within the grace if it remains. A leader
    // exit never discharges this obligation while owned descendants stay alive.
    const beginShutdown = (): void => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      clearFailureDeadline();
      frame = Buffer.alloc(0);
      cancelDrainWait?.();
      cancelDiagWait?.();
      stopStdin();
      if (child.pid === undefined) { settle(); return; }
      ownedShutdown = true;
      shutdownDischarged = false;
      signalGroup("SIGTERM");
      options.lifecycle?.record("shutdown-term");
      const shutdownAt = performance.now();
      pollTimer = setInterval(() => {
        if (!signalGroup(0)) { dischargeShutdown(); return; }
        if (performance.now() - shutdownAt >= TERM_GRACE_MS) {
          signalGroup("SIGKILL");
          options.lifecycle?.record("shutdown-kill");
          dischargeShutdown();
        }
      }, GROUP_POLL_MS);
    };

    // Group-cleanup obligation of a sticky failure: holds settlement until the
    // owned group is gone — discharged silently when it already is, or through
    // the TERM→KILL ladder when descendants survive the leader. Reached from
    // the close handler and from a failed frame decoded after close.
    const settleObligation = (): void => {
      if (shutdownStarted || finished) return;
      clearFailureDeadline();
      shutdownDischarged = false;
      if (!signalGroup(0)) { dischargeShutdown(); return; }
      beginShutdown();
    };

    // The first transport cause wins; consequences of our own shutdown are not
    // causes, and nothing after settlement changes the reported outcome. A
    // decided run excludes native post-terminal noise as well: a frame after
    // the terminal event cannot rewrite a delivered verdict.
    const recordFailure = (cause: "spawn" | "stdin" | "protocol" | "output"): void => {
      if (failure !== undefined || decided || shutdownStarted || finished) return;
      failure = cause;
      options.lifecycle?.record("failure", { class: cause });
      beginShutdown();
    };

    // A parent sink failure keeps first-cause rights until settlement: an
    // accepted write holds settlement open, so its failure is a pre-settlement
    // transport fact — not teardown noise — even after the decision's ladder
    // made recordFailure a no-op. An already-delivered operator abort outranks
    // a failure registered after it (spec TS-6).
    const recordOutputFailure = (): void => {
      if (failure !== undefined || finished || cancelled) return;
      failure = "output";
      beginShutdown();
    };

    const onAbort = (): void => { cancelled = true; options.lifecycle?.record("abort"); beginShutdown(); settle(); };
    const onOutputError = (): void => failSink("message");

    // Listener lifetime must cover our accepted bytes: while any write this
    // invocation made is still in flight, the sinks keep their error listeners,
    // so a late sink error can never be an unhandled emission.
    const detachSinkListeners = (): void => {
      output.removeListener("error", onOutputError);
      output.removeListener("close", onOutputError);
      diagnostics.removeListener("error", onDiagFailure);
      diagnostics.removeListener("close", onDiagFailure);
    };

    // Once a sink has errored or closed, write callbacks still outstanding on
    // it can never arrive (destroy() during a pending _write is never
    // completed); its entries are discharged so settlement cannot wait forever
    // on a dead sink. The other sink's healthy writes keep their own accounting.
    const failSink = (kind: "message" | "diag"): void => {
      pendingWrites[kind] = 0;
      if (finished) {
        // A settled run still owns its sinks' late emissions; once this known
        // failure leaves no write in flight on either sink, release them.
        if (pendingWrites.message === 0 && pendingWrites.diag === 0) detachSinkListeners();
        return;
      }
      recordOutputFailure();
      // A prior first failure, a settled run, or a delivered abort makes the
      // recorder a no-op, but the discharge above still has to re-drive
      // settlement.
      settle();
    };

    // Completion or error of every accepted write, per sink.
    const ackWrite = (kind: "message" | "diag", error?: Error | null): void => {
      pendingWrites[kind] = Math.max(0, pendingWrites[kind] - 1);
      if (error !== null && error !== undefined) {
        recordOutputFailure();
        // The failing sink emits its 'error' right after this callback
        // (nextTick); defer the detach past that emission so it stays owned,
        // then release the sinks — no late ack may leave a permanent listener.
        if (pendingWrites.message === 0 && pendingWrites.diag === 0) setImmediate(detachSinkListeners);
        return;
      }
      if (finished) {
        if (pendingWrites.message === 0 && pendingWrites.diag === 0) detachSinkListeners();
        return;
      }
      settle();
    };
    const onMessageAck = (error?: Error | null): void => ackWrite("message", error);
    const onDiagAck = (error?: Error | null): void => ackWrite("diag", error);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    // Early spawn-error listener precedes any stdin use.
    child.once("error", () => { recordFailure("spawn"); });
    output.on("error", onOutputError);
    output.on("close", onOutputError);

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
        if (failed) { recordOutputFailure(); return; }
        stdout.resume();
        if (!shutdownStarted && !finished) processFrames();
      };
      output.once("drain", onDrain);
      output.once("error", onFailed);
      output.once("close", onFailed);
      return () => completeWait(false);
    };

    const emitMessage = (text: string): void => {
      pendingWrites.message += 1;
      let accepted: boolean;
      try {
        accepted = output.write(text + "\n", onMessageAck);
      } catch {
        pendingWrites.message = Math.max(0, pendingWrites.message - 1);
        recordOutputFailure();
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
        if (failed) { recordOutputFailure(); return; }
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
      pendingWrites.diag += 1;
      let accepted: boolean;
      try {
        accepted = diagnostics.write(line, onDiagAck);
      } catch {
        pendingWrites.diag = Math.max(0, pendingWrites.diag - 1);
        recordOutputFailure();
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

    // One fixed line per failed run, written by its first failed turn; the
    // taxonomy class is the only failure-text derivative that ever reaches
    // the diagnostics sink.
    const reportWorkerFailed = (failureClass: FailureClass): void => {
      if (shutdownStarted || finished) return;
      const line = "turnhelm: worker-failed: " + failureClass + "\n";
      if (cancelDiagWait !== undefined) { diagLine = line; return; }
      writeDiagLine(line);
    };

    // One fixed-category line per diagnostic event; never the raw command,
    // output, stderr, or native error text behind it. While the sink is
    // blocked, at most the latest new event's line is retained — the queue
    // cannot grow with the event count, and accepted lines are never rewritten.
    const reportDiagnostic = (category: "worker-event-error" | "worker-activity"): void => {
      if (shutdownStarted || finished) return;
      const line = "turnhelm: " + category + "\n";
      if (cancelDiagWait !== undefined) { diagLine = line; return; }
      writeDiagLine(line);
    };

    const dispatch = (event: WorkerEvent): void => {
      switch (event.kind) {
        case "message":
          // Retained, never forwarded: the last decoded message becomes the
          // single settlement-time stdout write.
          finalMessage = event.text;
          return;
        case "completed":
          completionSeen = true;
          options.lifecycle?.record("completion");
          // Latest valid snapshot replaces; absent or empty usage keeps the earlier one.
          if (event.usage) usage = event.usage;
          tryDecide();
          return;
        case "failed":
          // Post-terminal noise cannot rewrite a decided verdict.
          if (decided) return;
          // Irreversible: a later completion cannot restore success. The first
          // failure event owns the attribution and the single diagnostic line;
          // the deadline, not an immediate shutdown, now bounds the
          // group-cleanup obligation.
          if (!stickyFailed) {
            reportWorkerFailed(event.failureClass);
            // EV-1: the observed failure class from the frozen taxonomy rides
            // the timeline — never the message prose behind it.
            options.lifecycle?.record("failure", { class: event.failureClass });
          }
          stickyFailed = true;
          if (failureClass === undefined) {
            failureClass = event.failureClass;
            failureHash = event.errorSha256;
          }
          // A frame held back by sink backpressure can only be decoded after
          // the child closed; the close handler saw no sticky failure then, so
          // the obligation discharges here — settlement cannot outrun cleanup.
          if (closed) { settleObligation(); return; }
          startFailureDeadline();
          return;
        case "diagnostic":
          if (event.category === "worker-event-error" && failureClass === undefined) {
            failureClass = event.failureClass;
            failureHash = event.errorSha256;
          }
          reportDiagnostic(event.category);
          return;
        case "activity":
          // An observation only: never a completion, failure, or output fact.
          // Only a completed item reports the fixed diagnostic; started and
          // updated items stay silent under the same lossy discipline.
          if (event.itemPhase === "completed") reportDiagnostic("worker-activity");
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
        progressEvents += 1;
        lastEventAt = performance.now();
        options.lifecycle?.record("event", event.kind === "activity"
          ? { eventKind: "activity", itemKind: event.itemKind, itemPhase: event.itemPhase,
              ...(event.itemStatus === undefined ? {} : { itemStatus: event.itemStatus }),
              ...(event.itemExitCode === undefined ? {} : { itemExitCode: event.itemExitCode }) }
          : { eventKind: event.kind });
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
      stdin.end(task, (error?: Error | null) => { if (!error) { inputDelivered = true; options.lifecycle?.record("stdin-delivered"); tryDecide(); } });
      stderr.on("error", () => { /* Drained and discarded; never stalls stdout. */ });
      stderr.resume();
      stdout.on("data", (chunk: Buffer) => {
        if (shutdownStarted || finished) return;
        frame = frame.length === 0 ? chunk : Buffer.concat([frame, chunk]);
        processFrames();
      });
      stdout.once("end", () => {
        stdoutEnded = true;
        options.lifecycle?.record("stdout-end");
        checkFinalTail();
        settle();
      });
      stdout.on("error", () => { recordFailure("output"); });
    }

    child.once("close", (code, signal) => {
      closed = true;
      childCode = code;
      childSignal = signal;
      options.lifecycle?.record("close", { exitCode: code, signal: signal ?? undefined });
      if (stickyFailed) settleObligation();
      settle();
    });
  });
}
