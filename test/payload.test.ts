import assert from "node:assert/strict";
import test from "node:test";
import { envelopePayload, inertTrailerLine } from "../src/payload.js";

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
