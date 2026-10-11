import type { ProfileId, ProjectConfig, TaskProfile } from "./config.js";
import { classifierFailure, directChoiceRequest, eligibleBackends, requestTaskChoice,
  type ChoiceRequest, type ClassifierFailure, type TaskAttempt, type TaskBackend } from "./systemone.js";
import { validateTask } from "./task.js";

export type TaskDecision = Readonly<{
  backend: TaskBackend;
  profileId: ProfileId;
  profile: TaskProfile;
  attempts: readonly TaskAttempt[];
  routingMs: number;
  confidence?: number;
}>;

export type RoutingResult =
  | Readonly<{ status: "selected"; decision: TaskDecision }>
  | Readonly<{ status: "failed" | "cancelled"; attempts: readonly TaskAttempt[]; routingMs: number }>;

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const composeSignal = (caller: AbortSignal | undefined, deadline: AbortSignal): AbortSignal =>
  caller ? AbortSignal.any([caller, deadline]) : deadline;

// Caller cancellation and the deadline outrank any transport error landing at
// the same moment; both are fixed projections with nothing observed to keep.
const CALLER_ABORTED: ClassifierFailure = Object.freeze({ kind: "aborted", httpStatus: null, code: null });
const DEADLINE_EXCEEDED: ClassifierFailure = Object.freeze({ kind: "timeout", httpStatus: null, code: null });

export async function routeTask(
  task: string,
  config: ProjectConfig,
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }
): Promise<RoutingResult> {
  validateTask(task);
  const started = performance.now();
  const caller = options.signal;
  const request = options.request ?? directChoiceRequest;
  const attempts: TaskAttempt[] = [];
  const elapsed = () => Math.round(performance.now() - started);
  const cancelled = (): RoutingResult => deepFreeze({ status: "cancelled", attempts, routingMs: elapsed() });
  if (caller?.aborted) return cancelled();
  const backends = eligibleBackends(config, options.env);
  for (const backend of backends) {
    if (caller?.aborted) return cancelled();
    const remaining = config.routingTimeoutMs - elapsed();
    if (remaining <= 0) break;
    // CPU Laya can take seconds; reserve a quarter of the remaining deadline for Jev.
    const budget = backends.length > 1 && backend === "laya" ? Math.floor(remaining * 3 / 4) : remaining;
    const signal = composeSignal(caller, AbortSignal.timeout(budget));
    attempts.push({ backend, outcome: "success", durationMs: 0 });
    const attemptStarted = performance.now();
    const conclude = (outcome: "failed" | "timeout" | "cancelled", failure: ClassifierFailure, at: number): void => {
      attempts[attempts.length - 1] = { backend, outcome, durationMs: Math.round(at - attemptStarted), failure };
    };
    try {
      const { profileId, confidence } = await requestTaskChoice(config, task, backend, options.env, signal, request);
      const finished = performance.now();
      attempts[attempts.length - 1] = { backend, outcome: "success", durationMs: Math.round(finished - attemptStarted) };
      if (caller?.aborted) {
        conclude("cancelled", CALLER_ABORTED, finished);
        return cancelled();
      }
      if (finished - attemptStarted > budget) {
        conclude("timeout", DEADLINE_EXCEEDED, finished);
        continue;
      }
      const decision = deepFreeze({
        backend, profileId, profile: config.profiles[profileId], attempts, routingMs: elapsed(),
        ...(confidence !== undefined ? { confidence } : {})
      });
      return { status: "selected", decision };
    } catch (error) {
      const at = performance.now();
      const timedOut = !caller?.aborted && (signal.aborted || at - attemptStarted > budget);
      conclude(
        caller?.aborted ? "cancelled" : timedOut ? "timeout" : "failed",
        caller?.aborted ? CALLER_ABORTED : timedOut ? DEADLINE_EXCEEDED : classifierFailure(error),
        at
      );
      if (caller?.aborted) return cancelled();
    }
  }
  return caller?.aborted ? cancelled() : deepFreeze({ status: "failed", attempts, routingMs: elapsed() });
}
