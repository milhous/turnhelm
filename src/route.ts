import type { ProfileId, ProjectConfig, TaskProfile } from "./config.js";
import { directChoiceRequest, eligibleBackends, requestTaskChoice,
  type ChoiceRequest, type TaskAttempt, type TaskBackend } from "./systemone.js";
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

type MutableAttempt = { backend: TaskBackend; outcome: TaskAttempt["outcome"]; durationMs: number };

export async function routeTask(
  task: string,
  config: ProjectConfig,
  options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; request?: ChoiceRequest }
): Promise<RoutingResult> {
  validateTask(task);
  const started = performance.now();
  const caller = options.signal;
  const request = options.request ?? directChoiceRequest;
  const attempts: MutableAttempt[] = [];
  const elapsed = () => Math.round(performance.now() - started);
  const cancelled = (): RoutingResult => deepFreeze({ status: "cancelled", attempts, routingMs: elapsed() });
  if (caller?.aborted) return cancelled();
  const backends = eligibleBackends(config, options.env);
  const layaShare = Math.min(1000, Math.floor(config.routingTimeoutMs / 4));
  for (const backend of backends) {
    if (caller?.aborted) return cancelled();
    const remaining = config.routingTimeoutMs - elapsed();
    if (remaining <= 0) break;
    const budget = backends.length > 1 && backend === "laya" ? Math.min(layaShare, remaining) : remaining;
    const signal = composeSignal(caller, AbortSignal.timeout(budget));
    const attempt: MutableAttempt = { backend, outcome: "success", durationMs: 0 };
    attempts.push(attempt);
    const attemptStarted = performance.now();
    try {
      const { profileId, confidence } = await requestTaskChoice(config, task, backend, options.env, signal, request);
      attempt.durationMs = Math.round(performance.now() - attemptStarted);
      if (caller?.aborted) {
        attempt.outcome = "cancelled";
        return cancelled();
      }
      if (performance.now() - attemptStarted > budget) {
        attempt.outcome = "timeout";
        continue;
      }
      const decision = deepFreeze({
        backend, profileId, profile: config.profiles[profileId], attempts, routingMs: elapsed(),
        ...(confidence !== undefined ? { confidence } : {})
      });
      return { status: "selected", decision };
    } catch {
      attempt.durationMs = Math.round(performance.now() - attemptStarted);
      if (caller?.aborted) {
        attempt.outcome = "cancelled";
        return cancelled();
      }
      attempt.outcome = signal.aborted || performance.now() - attemptStarted > budget ? "timeout" : "failed";
    }
  }
  return caller?.aborted ? cancelled() : deepFreeze({ status: "failed", attempts, routingMs: elapsed() });
}
