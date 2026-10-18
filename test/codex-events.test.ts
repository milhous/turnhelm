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
  // Started/updated items with absent or malformed metadata keep the ignored behavior.
  assert.deepEqual(decodeWorkerEvent(frame({ type: "item.started" })), { kind: "ignored" });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "item.updated", item: "text" })), { kind: "ignored" });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "item.started", item: { type: 42 } })), { kind: "ignored" });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "turn.completed", usage: { input_tokens: 1 }, extra_field: { nested: true }
  })), { kind: "completed", usage: { input_tokens: 1 } });
});

test("error events reduce to a fixed category; completed items project activity", () => {
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "error", message: "TEST_PRIVATE_ERROR_SENTINEL", stack: "TEST_PRIVATE_STACK_SENTINEL"
  })), {
    kind: "diagnostic", category: "worker-event-error",
    failureClass: "unknown", errorSha256: sha256("TEST_PRIVATE_ERROR_SENTINEL")
  });
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed",
    item: { type: "command_execution", command: "cat TEST_PRIVATE_TOOL_SENTINEL", aggregated_output: "TEST_PRIVATE_OUTPUT_SENTINEL", exit_code: 0 }
  })), { kind: "activity", itemKind: "command_execution", itemPhase: "completed", itemExitCode: 0 });
});

test("item lifecycle frames project bounded activity facts", () => {
  // All three phases come only from the root event type, never from item status.
  for (const [type, phase] of [["item.started", "started"], ["item.updated", "updated"], ["item.completed", "completed"]] as const) {
    // Exact known item kinds map to their fixed enums; native extra fields are discarded.
    assert.deepEqual(decodeWorkerEvent(frame({ type, item: { type: "reasoning", summary: "PRIVATE_REASONING_TEXT", id: "item_PRIVATE_ID" } })),
      { kind: "activity", itemKind: "reasoning", itemPhase: phase });
    assert.deepEqual(decodeWorkerEvent(frame({ type, item: { type: "command_execution", command: "PRIVATE_COMMAND_TEXT", aggregated_output: "PRIVATE_OUTPUT_TEXT" } })),
      { kind: "activity", itemKind: "command_execution", itemPhase: phase });
    assert.deepEqual(decodeWorkerEvent(frame({ type, item: { type: "file_change", path: "/private/path" } })),
      { kind: "activity", itemKind: "file_change", itemPhase: phase });
    // Any other non-agent string item type collapses to "other"; the native name is not preserved.
    for (const nativeType of ["mcp_tool_call", "web_search", "todo_list"]) {
      assert.deepEqual(decodeWorkerEvent(frame({ type, item: { type: nativeType, arguments: { secret: "PRIVATE_MCP_TEXT" } } })),
        { kind: "activity", itemKind: "other", itemPhase: phase });
    }
    // Status is an independent observation copied only from the exact three-value whitelist.
    assert.deepEqual(decodeWorkerEvent(frame({ type, item: { type: "reasoning", status: "in_progress" } })),
      { kind: "activity", itemKind: "reasoning", itemPhase: phase, itemStatus: "in_progress" });
    assert.deepEqual(decodeWorkerEvent(frame({ type, item: { type: "web_search", status: "failed", query: "PRIVATE_QUERY_TEXT" } })),
      { kind: "activity", itemKind: "other", itemPhase: phase, itemStatus: "failed" });
    // Missing, null, or unknown status stays absent and is never replaced by the phase.
    for (const status of [undefined, null, "queued", "succeeded", 7]) {
      const projected = decodeWorkerEvent(frame({ type, item: { type: "reasoning", status } })) as Record<string, unknown>;
      assert.equal(projected.itemStatus, undefined, `status ${JSON.stringify(status)} must stay absent`);
    }
  }
  // A completed command carries its native exit code as a signed safe integer, zero included.
  assert.deepEqual(decodeWorkerEvent(frame({
    type: "item.completed", item: { type: "command_execution", status: "completed", exit_code: 13, command: "PRIVATE_COMMAND_TEXT", aggregated_output: "PRIVATE_OUTPUT_TEXT" }
  })), { kind: "activity", itemKind: "command_execution", itemPhase: "completed", itemStatus: "completed", itemExitCode: 13 });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "item.completed", item: { type: "command_execution", exit_code: 0 } })),
    { kind: "activity", itemKind: "command_execution", itemPhase: "completed", itemExitCode: 0 });
  assert.deepEqual(decodeWorkerEvent(frame({ type: "item.completed", item: { type: "command_execution", exit_code: -2 } })),
    { kind: "activity", itemKind: "command_execution", itemPhase: "completed", itemExitCode: -2 });
  // A failed command observation keeps both facts; the status is never normalized.
  assert.deepEqual(decodeWorkerEvent(frame({ type: "item.completed", item: { type: "command_execution", status: "failed", exit_code: 1 } })),
    { kind: "activity", itemKind: "command_execution", itemPhase: "completed", itemStatus: "failed", itemExitCode: 1 });
  // Invalid exit codes are omitted, never coerced or zero-filled.
  for (const exit_code of [null, "13", 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    const projected = decodeWorkerEvent(frame({ type: "item.completed", item: { type: "command_execution", exit_code } })) as Record<string, unknown>;
    assert.equal(projected.itemExitCode, undefined, `exit code ${JSON.stringify(exit_code)} must be omitted`);
  }
  // Exit codes ride completed commands only — never another kind or an earlier phase.
  for (const type of ["item.started", "item.updated"]) {
    const projected = decodeWorkerEvent(frame({ type, item: { type: "command_execution", exit_code: 13 } })) as Record<string, unknown>;
    assert.equal(projected.itemExitCode, undefined, `${type} must not carry an exit code`);
  }
  const otherKind = decodeWorkerEvent(frame({ type: "item.completed", item: { type: "file_change", exit_code: 13 } })) as Record<string, unknown>;
  assert.equal(otherKind.itemExitCode, undefined, "only command_execution may carry an exit code");
});

test("activity projections carry no native content", () => {
  const serialized = JSON.stringify([
    decodeWorkerEvent(frame({ type: "item.started", item: { type: "command_execution", command: "PRIVATE_COMMAND_TEXT" } })),
    decodeWorkerEvent(frame({ type: "item.completed", item: { type: "reasoning", summary: "PRIVATE_REASONING_TEXT" } })),
    decodeWorkerEvent(frame({ type: "item.completed", item: { type: "mcp", id: "item_PRIVATE_ID", arguments: { secret: "PRIVATE_MCP_TEXT" } } }))
  ]);
  for (const canary of ["PRIVATE_COMMAND_TEXT", "PRIVATE_REASONING_TEXT", "PRIVATE_MCP_TEXT", "item_PRIVATE_ID", "mcp"]) {
    assert.ok(!serialized.includes(canary), "canary leaked: " + canary);
  }
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
