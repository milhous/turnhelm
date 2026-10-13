import assert from "node:assert/strict";
import test from "node:test";
import { classifyPayload, envelopePayload, inertTrailerLine } from "../src/payload.js";

// The no-regression matrix for the envelope discipline moved verbatim from
// test/live-acceptance.ts: every case here is the frozen WH-2/VH-5 semantics,
// now owned by the product. Shapes mirror the sealed 2026-10-13 evidence
// (single-line payload + blank + prose) and live-acceptance.test.ts's pins.
test("envelopePayload extracts the line-1 value behind inert trailers only", () => {
  assert.deepEqual(envelopePayload('{"count":4,"sum":17}'), { value: { count: 4, sum: 17 } });
  assert.deepEqual(envelopePayload("42"), { value: 42 });
  assert.deepEqual(envelopePayload("true"), { value: true });
  assert.deepEqual(envelopePayload("null"), { value: null });
  assert.deepEqual(envelopePayload('{"a":true,"b":false,"c":true}\nDone.'), { value: { a: true, b: false, c: true } });
  // The sealed trailing-prose shapes: payload line, blank line, prose, trailing newline.
  assert.deepEqual(envelopePayload('{"case":"x","status":"complete"}\n\nprose here.\n'),
    { value: { case: "x", status: "complete" } });
  assert.deepEqual(envelopePayload('{"a":1}\n   indented explanation'), { value: { a: 1 } });
  assert.deepEqual(envelopePayload('  {"a":1}'), { value: { a: 1 } });
  assert.equal(envelopePayload('{"count":0,"sum":0} {"count":8,"sum":8}'), null);
  assert.equal(envelopePayload('[\n{"count":4,"sum":17}\n]'), null);
  assert.equal(envelopePayload("not json at all"), null);
  assert.equal(envelopePayload('{"a":true}\n{"b":false}'), null);
  assert.equal(envelopePayload('{"a":true}\n```'), null);
  assert.equal(envelopePayload('{"a":true}\n"quoted"'), null);
  assert.equal(envelopePayload('{"a":true}\n7'), null);
  assert.equal(envelopePayload(""), null);
  assert.equal(envelopePayload("\n"), null);
  assert.equal(envelopePayload("   "), null);
});

test("inertTrailerLine admits prose and blank lines, rejects structured or fence lines", () => {
  assert.equal(inertTrailerLine(""), true);
  assert.equal(inertTrailerLine("prose"), true);
  assert.equal(inertTrailerLine("   prose"), true);
  assert.equal(inertTrailerLine('{"b":false}'), false);
  assert.equal(inertTrailerLine('  {"b":false}'), false);
  assert.equal(inertTrailerLine('["x"]'), false);
  assert.equal(inertTrailerLine('"str"'), false);
  assert.equal(inertTrailerLine("7"), false);
  assert.equal(inertTrailerLine("true"), false);
  assert.equal(inertTrailerLine("null"), false);
  assert.equal(inertTrailerLine("```"), false);
  assert.equal(inertTrailerLine("```json"), false);
});

// PE-1 §3.2: the emission classifier's mode matrix. emittedText is the
// extractor text — the emitter appends its own "\n" outside the classifier,
// so a strict "{}\n" message keeps its trailing newline here.
const afterFirstLine = (message: string): string => message.slice(message.indexOf("\n") + 1);

test("classifyPayload: a whole-message JSON value is strict, verbatim", () => {
  assert.deepEqual(classifyPayload('{"a":1}'), { mode: "strict", emittedText: '{"a":1}' });
  assert.deepEqual(classifyPayload("42"), { mode: "strict", emittedText: "42" });
  assert.deepEqual(classifyPayload("{}\n"), { mode: "strict", emittedText: "{}\n" });
  assert.deepEqual(classifyPayload("  [1, 2]  "), { mode: "strict", emittedText: "  [1, 2]  " });
  // Pretty-printed JSON parses whole: strict, multi-line, verbatim. The harness
  // oracle still rejects it via envelopePayload — each consumer applies its own
  // predicate to one shared definition.
  assert.deepEqual(classifyPayload('[{"a":1}\n]'), { mode: "strict", emittedText: '[{"a":1}\n]' });
  assert.deepEqual(classifyPayload('[\n{"count":4,"sum":17}\n]'),
    { mode: "strict", emittedText: '[\n{"count":4,"sum":17}\n]' });
  // A payload followed only by blank lines parses whole: strict, verbatim —
  // whole-message precedence (§3.2a) sits ahead of extraction (§3.2b).
  assert.deepEqual(classifyPayload('{"a":1}\n\n\n'), { mode: "strict", emittedText: '{"a":1}\n\n\n' });
});

test("classifyPayload: first-line JSON with inert trailers extracts the first line", () => {
  const sealed = '{"case":"x","status":"complete"}\n\n未访问网络；冻结测试通过。\n';
  assert.deepEqual(classifyPayload(sealed), {
    mode: "extracted",
    emittedText: '{"case":"x","status":"complete"}',
    trailerBytes: new TextEncoder().encode(afterFirstLine(sealed)).length,
  });
  assert.deepEqual(classifyPayload('{"a":1}\nDone.'), { mode: "extracted", emittedText: '{"a":1}', trailerBytes: 5 });
  assert.deepEqual(classifyPayload('{"a":1}\n\nprose\n\n'), { mode: "extracted", emittedText: '{"a":1}', trailerBytes: 8 });
});

test("classifyPayload: first-line JSON with a non-inert trailer is conflict, verbatim", () => {
  const cases = ['{"a":1}\n{"b":2}', '{"a":1}\n```', '{"a":1}\n7', '{"a":1}\n"quoted"', '{"a":1}\n  {"b":2}'];
  for (const message of cases) {
    assert.deepEqual(classifyPayload(message), { mode: "conflict", emittedText: message });
  }
});

test("classifyPayload: prose, empty, and truncated first lines are unstructured, verbatim", () => {
  const cases = ["not json at all", "", '{"a":1', '  ', 'two values {"a":1} {"b":2}', 'prettier [\n1\n] but not whole'];
  for (const message of cases) {
    assert.deepEqual(classifyPayload(message), { mode: "unstructured", emittedText: message });
  }
});
