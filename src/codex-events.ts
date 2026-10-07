export type WorkerUsage = Readonly<{
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  reasoning_output_tokens?: number;
}>;

export type WorkerEvent =
  | Readonly<{ kind: "message"; text: string }>
  | Readonly<{ kind: "completed"; usage?: WorkerUsage }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "diagnostic"; category: "worker-event-error" | "tool-progress" }>
  | Readonly<{ kind: "ignored" }>;

export const MAX_EVENT_BYTES = 1048576;

const USAGE_FIELDS: readonly (keyof WorkerUsage)[] = [
  "input_tokens", "output_tokens", "cached_input_tokens", "reasoning_output_tokens"
];

const FRAME_DECODER = new TextDecoder("utf-8", { fatal: true });

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const counter = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const usageSnapshot = (value: unknown): WorkerUsage | undefined => {
  if (!object(value)) throw new Error("worker event usage must be an object");
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
  if (type === "turn.failed") return { kind: "failed" };
  if (type === "error") return { kind: "diagnostic", category: "worker-event-error" };
  if (type === "item.completed") {
    if (!object(event.item) || typeof event.item.type !== "string") {
      throw new Error("completed item is not well-formed");
    }
    if (event.item.type === "agent_message") {
      if (typeof event.item.text !== "string") throw new Error("agent message text must be a string");
      return { kind: "message", text: event.item.text };
    }
    return { kind: "diagnostic", category: "tool-progress" };
  }
  return { kind: "ignored" };
}
