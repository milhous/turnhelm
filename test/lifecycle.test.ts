// Unit tests for the bounded content-free lifecycle recorder (EV-1, spec §3.2):
// the ring keeps the head and the settlement tail no matter how many events a
// run produces, and the append sink sees every event as it occurs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LIFECYCLE_CAPACITY, LIFECYCLE_HEAD_KEEP, LifecycleRecorder, type LifecycleEvent } from "../src/lifecycle.js";
import type { WorkerActivity } from "../src/codex-events.js";

test("the retention split is the exported head constant over the fixed capacity", () => {
  assert.equal(LIFECYCLE_CAPACITY, 64);
  assert.equal(LIFECYCLE_HEAD_KEEP, 8);
  const recorder = new LifecycleRecorder(() => {});
  recorder.record("spawned", { pid: 4242 });
  const activity: WorkerActivity = {
    itemKind: "command_execution", itemPhase: "completed", itemStatus: "failed", itemExitCode: 13
  };
  recorder.record("event", { eventKind: "activity", ...activity });
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.overflow, false);
  assert.equal(snapshot.events.length, 2);
  assert.deepEqual(snapshot.events[1].detail,
    { eventKind: "activity", itemKind: "command_execution", itemPhase: "completed", itemStatus: "failed", itemExitCode: 13 });
});

test("ring keeps the head, the tail, and an overflow marker", () => {
  const persisted: LifecycleEvent[] = [];
  const recorder = new LifecycleRecorder(event => persisted.push(event));
  recorder.record("spawned", { pid: 4242 });
  for (let index = 0; index < 200; index += 1) recorder.record("event", { eventKind: "item.completed" });
  recorder.record("settle", { status: "completed" });
  const snapshot = recorder.snapshot();
  assert.ok(snapshot.overflow, "more than 64 recorded events trip the overflow marker");
  assert.equal(snapshot.events.length, LIFECYCLE_CAPACITY, "the ring still holds exactly 64 entries");
  assert.equal(snapshot.events[0].kind, "spawned", "the head is kept");
  assert.equal(snapshot.events.at(-1)?.kind, "settle", "the settlement tail is kept");
  for (let index = 1; index < snapshot.events.length; index += 1) {
    assert.ok(snapshot.events[index].tMs >= snapshot.events[index - 1].tMs,
      "tMs stays non-decreasing at index " + index);
  }
  assert.equal(persisted.length, 202, "the append sink received every event as it occurred");
  assert.deepEqual(persisted.at(-1), snapshot.events.at(-1), "the sink sees the same final event");

  const exact = new LifecycleRecorder(() => {});
  for (let index = 0; index < LIFECYCLE_CAPACITY; index += 1) exact.record("event");
  assert.equal(exact.snapshot().overflow, false, "exactly 64 events is not overflow");
  assert.equal(exact.snapshot().events.length, LIFECYCLE_CAPACITY);
});
