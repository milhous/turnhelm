// EV-1 (spec §3.2): an opt-in, bounded, content-free lifecycle record for one
// worker execution. Every event is a kind plus a monotonic age in
// milliseconds and a fixed-shape detail projection — never worker output,
// task text, or error prose. The ring keeps the first 8 and the last 56
// entries, so an event flood cannot erase either how the run began or how it
// settled; the settle event is recorded last and always survives in the tail.

export type LifecycleKind = "spawned" | "stdin-delivered" | "event" | "completion" | "failure"
  | "abort" | "shutdown-term" | "shutdown-kill" | "shutdown-discharged" | "stdout-end" | "close" | "settle";

import type { WorkerActivity } from "./codex-events.js";

// A lifecycle detail is either a process/settlement observation or a decoded
// activity projection — never a mix of the two field families.
export type LifecycleEvent = Readonly<{ tMs: number; kind: LifecycleKind;
  detail?:
    | Readonly<{ eventKind?: string; pid?: number; exitCode?: number | null; signal?: string; status?: string; class?: string }>
    | Readonly<{ eventKind: "activity" } & WorkerActivity> }>;

export const LIFECYCLE_CAPACITY = 64;
export const LIFECYCLE_HEAD_KEEP = 8;
const TAIL_KEEP = LIFECYCLE_CAPACITY - LIFECYCLE_HEAD_KEEP;

export class LifecycleRecorder {
  private readonly append: (event: LifecycleEvent) => void;
  private readonly head: LifecycleEvent[] = [];
  private readonly tail: LifecycleEvent[] = [];
  private total = 0;
  private origin: number | undefined;

  constructor(append: (event: LifecycleEvent) => void) {
    this.append = append;
  }

  record(kind: LifecycleKind, detail?: LifecycleEvent["detail"]): void {
    const now = performance.now();
    if (this.origin === undefined) this.origin = now;
    const event: LifecycleEvent = {
      tMs: Math.round(now - this.origin),
      kind,
      ...(detail !== undefined ? { detail } : {})
    };
    this.total += 1;
    this.append(event);
    if (this.head.length < LIFECYCLE_HEAD_KEEP) this.head.push(event);
    else if (this.tail.push(event) > TAIL_KEEP) this.tail.shift();
  }

  snapshot(): Readonly<{ events: readonly LifecycleEvent[]; overflow: boolean }> {
    return { events: [...this.head, ...this.tail], overflow: this.total > LIFECYCLE_CAPACITY };
  }
}
