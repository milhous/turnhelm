import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export const SCHEMA_MAX_BYTES = 64 * 1024;

// OC-1: the opt-in output schema is validated exactly once at the input
// boundary, so only already-validated bytes cross toward the worker, which
// stages its own copy inside the managed home — the caller's path is never
// forwarded or re-read. O_NOFOLLOW pins the open to a regular file and
// O_NONBLOCK keeps a FIFO from wedging the event loop before fstat can
// reject it; the size cap, UTF-8, and plain-object checks bound what may
// pass. Every rejection is fixed wording; file content never reaches a
// diagnostic.
export function validateOutputSchema(path: string): { bytes: Buffer } | { error: string } {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return { error: "the output schema path is not a readable regular file." };
  }
  try {
    try {
      if (!fstatSync(descriptor).isFile()) return { error: "the output schema path is not a readable regular file." };
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, SCHEMA_MAX_BYTES + 1 - total));
        const got = readSync(descriptor, chunk, 0, chunk.length, null);
        if (got === 0) break;
        total += got;
        if (total > SCHEMA_MAX_BYTES) return { error: "the output schema exceeds the 65536-byte limit." };
        chunks.push(chunk.subarray(0, got));
      }
      const bytes = Buffer.concat(chunks);
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { error: "the output schema is not valid UTF-8." };
      }
      try {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return { error: "the output schema must be a single JSON object." };
        }
      } catch {
        return { error: "the output schema must be a single JSON object." };
      }
      return { bytes };
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // A descriptor-level fault (fstat/read I/O error) keeps the same fixed
    // usage-error wording instead of escaping as an internal failure.
    return { error: "the output schema path is not a readable regular file." };
  }
}
