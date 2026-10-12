import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { decodeWorkerEvent, FAILURE_PHRASINGS, type FailureClass } from "../src/codex-events.js";

const frame = (e: unknown) => Buffer.from(JSON.stringify(e));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

test("decodes one completed message without a transcript", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed", item: { type: "agent_message", text: "result" }
  })), { kind: "message", text: "result" });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.failed" })), {
    kind: "failed", failureClass: "unknown"
  });
});

test("partial valid usage survives; invalid counters are not zero", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.completed", usage: { input_tokens: 10, output_tokens: -1 }
  })), { kind: "completed", usage: { input_tokens: 10 } });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.completed" })), { kind: "completed" });
});

test("valid oversized JSON is rejected by byte limit", () => {
  const prefix = frame({ type: "future.event" });
  const exact = Buffer.concat([prefix, Buffer.alloc(1048576 - prefix.length, 0x20)]);
  assert.deepEqual(decodeWorkerEvent(exact), { kind: "ignored" });
  assert.throws(() => decodeWorkerEvent(Buffer.concat([exact, Buffer.of(0x20)])));
  assert.throws(() => decodeWorkerEvent(Uint8Array.of(0xc3, 0x28)));
  assert.throws(() => decodeWorkerEvent(Buffer.from("not-json")));
});

test("usage counters are validated per field and never summed", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.completed",
    usage: { input_tokens: 3, output_tokens: 0, cached_input_tokens: 2, reasoning_output_tokens: 1 }
  })), { kind: "completed", usage: { input_tokens: 3, output_tokens: 0, cached_input_tokens: 2, reasoning_output_tokens: 1 } });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.completed",
    usage: { input_tokens: 1.5, output_tokens: Number.MAX_SAFE_INTEGER + 1, cached_input_tokens: -2, reasoning_output_tokens: "9" }
  })), { kind: "completed" });
});

test("unknown well-formed event types are ignored without schema guessing", () => {
  assert.deepEqual(decodeWorkerEvent(frame({ type: "thread.started", thread_id: "t" })), { kind: "ignored" });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.started", item: { type: "command_execution", command: "ls" }
  })), { kind: "ignored" });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.completed", usage: { input_tokens: 1 }, extra_field: { nested: true }
  })), { kind: "completed", usage: { input_tokens: 1 } });
});

test("error and tool progress events reduce to fixed categories", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL", stack: "TEST_PRIVATE_STACK_SENTINEL"
  })), {
    kind: "diagnostic", category: "worker-event-error",
    failureClass: "unknown", errorSha256: sha256("TEST_PRIVATE_ERROR_SENTINEL")
  });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed",
    item: { type: "command_execution", command: "cat TEST_PRIVATE_TOOL_SENTINEL", aggregated_output: "TEST_PRIVATE_OUTPUT_SENTINEL", exit_code: 0 }
  })), { kind: "diagnostic", category: "tool-progress" });
});

test("each frozen taxonomy phrase maps to its failure class on both frame kinds", () => {
  for (const [failureClass, phrase] of FAILURE_PHRASINGS) {
    const diagnostic = decodeWorkerEvent(frame({
      type: "error", message: `upstream reported ${phrase.toUpperCase()} mid-turn`
    }));
    assert.deepEqual(diagnostic, {
      kind: "diagnostic", category: "worker-event-error",
      failureClass, errorSha256: sha256(`upstream reported ${phrase.toUpperCase()} mid-turn`)
    }, `phrase "${phrase}" on an error frame`);
    const failed = decodeWorkerEvent(frame({
      type: "turn.failed", message: `upstream reported ${phrase} mid-turn`
    }));
    assert.deepEqual(failed, {
      kind: "failed", failureClass, errorSha256: sha256(`upstream reported ${phrase} mid-turn`)
    }, `phrase "${phrase}" on a turn.failed frame`);
  }
});

test("a nested error.message string classifies like a top-level message", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.failed", error: { message: "rate limit exceeded for key", code: 429 }
  })), { kind: "failed", failureClass: "rate-limit", errorSha256: sha256("rate limit exceeded for key") });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "error", error: { message: "request timed out after 60000ms" }
  })), {
    kind: "diagnostic", category: "worker-event-error",
    failureClass: "timeout", errorSha256: sha256("request timed out after 60000ms")
  });
});

test("unmatched text maps to unknown but still carries the correlation hash", () => {
  const raw = "a failure phrasing the taxonomy has never seen";
  assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.failed", message: raw })), {
    kind: "failed", failureClass: "unknown", errorSha256: sha256(raw)
  });
});

test("absent or non-string messages yield unknown with no hash", () => {
  for (const message of [undefined, 42, { nested: true }, ["array"]]) {
    assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.failed", message })), {
      kind: "failed", failureClass: "unknown"
    });
    assert.deepEqual(decodeWorkerEvent(frame({ type: "error", message })), {
      kind: "diagnostic", category: "worker-event-error", failureClass: "unknown"
    });
  }
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.failed", error: { message: 99 }
  })), { kind: "failed", failureClass: "unknown" });
});

test("canary: a hostile message yields class and hash only, never text", () => {
  const raw = "password=p@ss.word! and Bearer sk-abc123def456 plus The redacted migration must preserve every tenant row.";
  const event = decodeWorkerEvent(frame({ type: "turn.failed", message: raw }));
  assert.deepEqual(Object.keys(event).sort(), ["errorSha256", "failureClass", "kind"]);
  const serialized = JSON.stringify(event);
  assert.ok(!serialized.includes(raw), "the raw message must not survive");
  for (let i = 0; i + 20 <= raw.length; i++) {
    assert.ok(!serialized.includes(raw.slice(i, i + 20)), `20-char window at ${i} must not survive`);
  }
});

test("a multi-kilobyte message hashes without size-dependent behavior", () => {
  const raw = `usage limit reached: ${"x".repeat(11 * 1024)}`;
  assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.failed", message: raw })), {
    kind: "failed", failureClass: "usage-limit", errorSha256: sha256(raw)
  });
});

test("the frozen failure-class union and phrasing table are closed", () => {
  assert.deepEqual([...new Set(FAILURE_PHRASINGS.map(([c]) => c))].sort(), [
    "auth", "overloaded", "rate-limit", "stream-disconnected", "timeout", "usage-limit"
  ] as FailureClass[]);
  for (const [failureClass] of FAILURE_PHRASINGS) {
    assert.notEqual(failureClass, "unknown", "the table never names the catch-all");
  }
});

test("agent message text must be a string", () => {
  assert.throws(() => decodeWorkerEvent(frame({
    type: "item.completed", item: { type: "agent_message", text: 7 }
  })));
  assert.throws(() => decodeWorkerEvent(frame({
    type: "item.completed", item: { type: "agent_message" }
  })));
});

test("frames that are not well-formed event objects are fatal", () => {
  assert.throws(() => decodeWorkerEvent(frame([1, 2])));
  assert.throws(() => decodeWorkerEvent(frame(null)));
  assert.throws(() => decodeWorkerEvent(frame("nope")));
  assert.throws(() => decodeWorkerEvent(frame({ nope: true })));
  assert.throws(() => decodeWorkerEvent(frame({ type: 9 })));
  assert.throws(() => decodeWorkerEvent(frame({ type: "item.completed" })));
  assert.throws(() => decodeWorkerEvent(frame({ type: "item.completed", item: "text" })));
});

test("non-object accounting degrades to unreported usage, never a failure", () => {
  for (const usage of [null, false, 8, "unknown", []]) {
    assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.completed", usage })), { kind: "completed" });
  }
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.completed", usage: { input_tokens: 3, extra: true }
  })), { kind: "completed", usage: { input_tokens: 3 } });
});
