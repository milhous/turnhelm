import { createHash } from "node:crypto";
export type WorkerUsage = Readonly<{
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}>;

// The bounded activity projection of a native item lifecycle frame: fixed
// enums plus one validated optional numeric scalar. Never the native type
// name, command, output, path, item ID, or reasoning text.
export type WorkerActivity = Readonly<{
  itemKind: "reasoning" | "command_execution" | "file_change" | "other";
  itemPhase: "started" | "updated" | "completed";
  itemStatus?: "in_progress" | "completed" | "failed";
  itemExitCode?: number;
}>;

export type WorkerEvent =
  | Readonly<{ kind: "message"; text: string }>
  | Readonly<{ kind: "completed"; usage?: WorkerUsage }>
  | Readonly<{ kind: "failed"; failureClass: FailureClass; errorSha256?: string }>
  | Readonly<{ kind: "diagnostic"; category: "worker-event-error"; failureClass: FailureClass; errorSha256?: string }>
  | Readonly<{ kind: "activity" } & WorkerActivity>
  | Readonly<{ kind: "ignored" }>;

// Native error text is never retained: a message reduces to one frozen class
// plus a SHA-256 of its bytes for cross-run correlation, the same discipline
// as taskSha256. The table grows only by adding a phrasing with a test; an
// unmatched or absent message is "unknown" and never passed through.
export type FailureClass =
  | "stream-disconnected" | "rate-limit" | "usage-limit" | "timeout" | "auth" | "overloaded" | "unknown";

export const FAILURE_PHRASINGS: ReadonlyArray<readonly [Exclude<FailureClass, "unknown">, string]> = Object.freeze([
  ["stream-disconnected", "stream disconnected"],
  ["stream-disconnected", "disconnected before completion"],
  ["rate-limit", "rate limit"],
  ["usage-limit", "usage limit"],
  ["timeout", "timed out"],
  ["timeout", "timeout"],
  ["auth", "unauthorized"],
  ["auth", "authentication"],
  ["auth", "invalid api key"],
  ["overloaded", "overloaded"]
] as const);

export const classifyFailure = (raw: string): { failureClass: FailureClass; errorSha256: string } => {
  const lower = raw.toLowerCase();
  for (const [failureClass, phrase] of FAILURE_PHRASINGS) {
    if (lower.includes(phrase)) return { failureClass, errorSha256: createHash("sha256").update(raw, "utf8").digest("hex") };
  }
  return { failureClass: "unknown", errorSha256: createHash("sha256").update(raw, "utf8").digest("hex") };
};

export const MAX_EVENT_BYTES = 1048576;

const USAGE_FIELDS: readonly (keyof WorkerUsage)[] = [
  "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"
];

const FRAME_DECODER = new TextDecoder("utf-8", { fatal: true });

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The only failure-message extraction point: a top-level string `message`, or
// a string `error.message`; anything else is eventless ("unknown", no hash).
const failureOf = (event: Record<string, unknown>): { failureClass: FailureClass; errorSha256?: string } => {
  const message = typeof event.message === "string" ? event.message
    : object(event.error) && typeof event.error.message === "string" ? event.error.message : undefined;
  return message === undefined ? { failureClass: "unknown" } : classifyFailure(message);
};

const counter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const usageSnapshot = (value: unknown): WorkerUsage | undefined => {
  // A non-object accounting container is an accounting defect, not a transport
  // failure: it degrades to "no usable usage" and never fails the run.
  if (!object(value)) return undefined;
  const snapshot: Record<string, number> = {};
  for (const field of USAGE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const count = counter(value[field]);
    if (count !== undefined) snapshot[field] = count;
  }
  return Object.keys(snapshot).length === 0 ? undefined : Object.freeze(snapshot);
};

// One raw frame in, one sanitized event out. Fatal on invalid transport, never on
// an unknown but well-formed type; usage fields are validated individually and
// never merged into overlapping totals.
// Item lifecycle frames project bounded activity facts: the phase comes only
// from the root event type, the kind only from an exact native type match, the
// status only from a three-value whitelist, and the exit code only as a signed
// safe integer on a completed command. Every other native field is discarded
// here, never forwarded to lifecycle or evidence parsers.
const ACTIVITY_ITEM_KINDS = new Set(["reasoning", "command_execution", "file_change"]);

const activityOf = (item: Record<string, unknown>, phase: "started" | "updated" | "completed"): WorkerActivity => {
  const itemKind = ACTIVITY_ITEM_KINDS.has(item.type as string) ? item.type as WorkerActivity["itemKind"] : "other";
  const status = item.status;
  const itemStatus = status === "in_progress" || status === "completed" || status === "failed" ? status : undefined;
  const exitCode = item.exit_code;
  const itemExitCode = phase === "completed" && itemKind === "command_execution"
    && typeof exitCode === "number" && Number.isSafeInteger(exitCode) ? exitCode : undefined;
  return {
    itemKind,
    itemPhase: phase,
    ...(itemStatus === undefined ? {} : { itemStatus }),
    ...(itemExitCode === undefined ? {} : { itemExitCode })
  };
};

export function decodeWorkerEvent(frame: Uint8Array): WorkerEvent {
  if (frame.byteLength > MAX_EVENT_BYTES) throw new Error("worker event exceeds 1 MiB");
  let event: unknown;
  try {
    event = JSON.parse(FRAME_DECODER.decode(frame));
  } catch {
    throw new Error("worker event is not a valid UTF-8 JSON frame");
  }
  if (!object(event) || typeof event.type !== "string") {
    throw new Error("worker event is not a well-formed event object");
  }
  const type = event.type;
  if (type === "turn.completed") {
    if (!Object.hasOwn(event, "usage")) return { kind: "completed" };
    const snapshot = usageSnapshot(event.usage);
    return snapshot ? { kind: "completed", usage: snapshot } : { kind: "completed" };
  }
  if (type === "turn.failed") return { kind: "failed", ...failureOf(event) };
  if (type === "error") return { kind: "diagnostic", category: "worker-event-error", ...failureOf(event) };
  if (type === "item.started" || type === "item.updated") {
    // Absent or malformed item metadata keeps the ignored behavior; optional
    // evidence never creates a protocol failure.
    if (!object(event.item) || typeof event.item.type !== "string") return { kind: "ignored" };
    return { kind: "activity", ...activityOf(event.item, type === "item.started" ? "started" : "updated") };
  }
  if (type === "item.completed") {
    if (!object(event.item) || typeof event.item.type !== "string") {
      throw new Error("completed item is not well-formed");
    }
    if (event.item.type === "agent_message") {
      if (typeof event.item.text !== "string") throw new Error("agent message text must be a string");
      return { kind: "message", text: event.item.text };
    }
    return { kind: "activity", ...activityOf(event.item, "completed") };
  }
  return { kind: "ignored" };
}
