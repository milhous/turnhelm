import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { LifecycleEvent } from "./lifecycle.js";
import type { RoutingResult } from "./route.js";

const TASK_ENCODER = new TextEncoder();

// The shared safe-append core behind both journals: skip known nonregular
// leaves, open final-leaf-protected for append-only creation, re-check the
// regular file, and never let a journaling failure fail the run. The per-event
// reopen is that discipline itself — each append re-verifies the regular leaf
// so a between-events substitution is caught — and its cost is bounded by the
// small fixed event count per run.
const appendJournalLine = async (
  journalPath: string,
  line: string,
  what: string,
  diagnostic: (message: string) => void
): Promise<void> => {
  try {
    // Skip known nonregular leaves; safe open below also protects substitutions.
    const stat = await lstat(journalPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (stat !== undefined && !stat.isFile()) {
      diagnostic("the " + what + " path is not a regular file; continuing without it.");
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
        diagnostic("the " + what + " path is not a regular file; continuing without it.");
        return;
      }
      await journal.appendFile(line + "\n");
    } finally {
      await journal.close();
    }
  } catch {
    // Best-effort evidence: a journaling failure must never fail the run.
    diagnostic("the " + what + " could not be appended; continuing without it.");
  }
};

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
    // CU-1: the bounded classifier-usage projection rides selection evidence
    // exactly like confidence — never on failed or cancelled routing.
    if (routing.decision.classifierUsage !== undefined) entry.classifierUsage = routing.decision.classifierUsage;
  }
  const journalPath = join(root, ".turnhelm", "routes.jsonl");
  await appendJournalLine(journalPath, JSON.stringify(entry), "route journal", diagnostic);
}

// EV-1 (spec §3.2): the per-run lifecycle journal — one bounded content-free
// JSON line per recorded worker event, appended best-effort under the same
// safe-open discipline as the route journal. The pid is the CLI's own: it
// correlates a journal file's lines across separate runs, never within one.
export async function appendLifecycleEvent(
  root: string,
  event: { pid: number } & LifecycleEvent,
  diagnostic: (message: string) => void = () => {}
): Promise<void> {
  const entry: Record<string, unknown> = {
    type: "turnhelm.worker-lifecycle",
    pid: event.pid,
    tMs: event.tMs,
    kind: event.kind
  };
  if (event.detail !== undefined) entry.detail = event.detail;
  await appendJournalLine(join(root, ".turnhelm", "lifecycle.jsonl"), JSON.stringify(entry), "lifecycle journal", diagnostic);
}
