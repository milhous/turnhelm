import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { RoutingResult } from "./route.js";

const TASK_ENCODER = new TextEncoder();

// ponytail: single-writer append with no rotation; rotate externally if this ever matters at scale.
// The journal stores the task hash, never the task text: the task is treated as
// sensitive everywhere else and the journal must not become a second copy of it.
export async function appendRouteJournal(
  root: string,
  task: string,
  routing: RoutingResult,
  diagnostic: (message: string) => void = () => {}
): Promise<void> {
  const bytes = TASK_ENCODER.encode(task);
  const selected = routing.status === "selected";
  const entry: Record<string, unknown> = {
    type: "turnhelm.route",
    ts: new Date().toISOString(),
    taskSha256: createHash("sha256").update(bytes).digest("hex"),
    taskBytes: bytes.length,
    status: routing.status,
    routingMs: selected ? routing.decision.routingMs : routing.routingMs,
    attempts: selected ? routing.decision.attempts : routing.attempts
  };
  if (selected) {
    entry.backend = routing.decision.backend;
    entry.profileId = routing.decision.profileId;
    entry.model = routing.decision.profile.model;
    entry.effort = routing.decision.profile.effort;
    if (routing.decision.confidence !== undefined) entry.confidence = routing.decision.confidence;
  }
  const journalPath = join(root, ".turnhelm", "routes.jsonl");
  try {
    // Skip known nonregular leaves; safe open below also protects substitutions.
    const stat = await lstat(journalPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (stat !== undefined && !stat.isFile()) {
      diagnostic("the route journal path is not a regular file; continuing without it.");
      return;
    }
    if (!(constants.O_NOFOLLOW > 0 && constants.O_NONBLOCK > 0)) {
      throw new Error("safe journal open flags are unavailable");
    }
    // Final-leaf protection only: parent directories and hardlinks remain trusted.
    const journal = await open(journalPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (!(await journal.stat()).isFile()) {
        diagnostic("the route journal path is not a regular file; continuing without it.");
        return;
      }
      await journal.appendFile(JSON.stringify(entry) + "\n");
    } finally {
      await journal.close();
    }
  } catch {
    // Best-effort evidence: a journaling failure must never fail the run.
    diagnostic("the route journal could not be appended; continuing without it.");
  }
}
