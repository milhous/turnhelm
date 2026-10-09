import { createHash } from "node:crypto";
import { appendFile, lstat } from "node:fs/promises";
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
    // lstat (not stat) so a symlink is seen as the link, not its target: the
    // journal stays a regular file inside the project and is never redirected
    // out of it, and a non-regular path (symlink, FIFO, directory) is skipped
    // instead of opened — an append to a readerless FIFO would block the run.
    const stat = await lstat(journalPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (stat !== undefined && !stat.isFile()) {
      diagnostic("the route journal path is not a regular file; continuing without it.");
      return;
    }
    await appendFile(journalPath, JSON.stringify(entry) + "\n");
  } catch {
    // Best-effort evidence: a journaling failure must never fail the run.
    diagnostic("the route journal could not be appended; continuing without it.");
  }
}
