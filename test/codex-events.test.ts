import test from "node:test";
import assert from "node:assert/strict";
import { decodeWorkerEvent } from "../src/codex-events.js";

const frame = (e: unknown) => Buffer.from(JSON.stringify(e));

test("decodes one completed message without a transcript", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed", item: { type: "agent_message", text: "result" }
  })), { kind: "message", text: "result" });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "turn.failed" })), { kind: "failed" });
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
  })), { kind: "diagnostic", category: "worker-event-error" });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed",
    item: { type: "command_execution", command: "cat TEST_PRIVATE_TOOL_SENTINEL", aggregated_output: "TEST_PRIVATE_OUTPUT_SENTINEL", exit_code: 0 }
  })), { kind: "diagnostic", category: "tool-progress" });
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
