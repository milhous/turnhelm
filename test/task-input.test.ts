import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { readTask, validateTask } from "../src/task.js";

const ttyStdin = () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  return stdin;
};

test("task bounds preserve original UTF-8 text", () => {
  assert.equal(validateTask("x".repeat(8192)), "x".repeat(8192));
  assert.throws(() => validateTask("x".repeat(8193)));
  assert.equal(validateTask("界".repeat(2730)), "界".repeat(2730));
  assert.throws(() => validateTask("界".repeat(2731)));
  assert.throws(() => validateTask(Uint8Array.of(0xc3, 0x28)));
  assert.throws(() => validateTask("task\0text"));
  assert.throws(() => validateTask(" do the above! "));
  assert.equal(validateTask("Continue fixing cache invalidation"), "Continue fixing cache invalidation");
  assert.equal(validateTask(" \nFix one bug. 😀\n "), " \nFix one bug. 😀\n ");
  assert.equal(validateTask("﻿Fix the parser"), "﻿Fix the parser");
  assert.throws(() => validateTask("\uD800"));
});

test("whole continuation-only forms are rejected with optional punctuation and whitespace", () => {
  for (const phrase of ["continue", "go on", "proceed", "do the above", "继续", "接着做", "按刚才的方案继续", "按上面做"]) {
    for (const suffix of ["", ".", "!", "。", "！", " .. ", "  ", "\n"]) {
      assert.throws(() => validateTask(phrase + suffix), /continuation/);
      assert.throws(() => validateTask("  " + phrase + suffix + "\n"), /continuation/);
    }
  }
});

test("meaningful tasks beginning with continuation words are accepted", () => {
  for (const task of [
    "Continue fixing cache invalidation",
    "go on a trip",
    "Proceed with the migration plan",
    "继续做下一个任务",
    "do the above, then stop and report"
  ]) {
    assert.equal(validateTask(task), task);
  }
});

test("TTY positional input never waits for EOF", async () => {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  stdin.isTTY = true;
  assert.equal(await readTask("Fix a bug", stdin), "Fix a bug");
  await assert.rejects(readTask(undefined, stdin));
  stdin.destroy();
});

test("positional input through a TTY is validated", async () => {
  const stdin = ttyStdin();
  await assert.rejects(readTask("continue", stdin));
  stdin.destroy();
});

test("nonempty pipe conflicts; empty pipe permits positional input", async () => {
  await assert.rejects(readTask("Fix A", Readable.from(["Fix B"])));
  assert.equal(await readTask("Fix A", Readable.from([])), "Fix A");
});

test("empty piped input without a positional argument is a usage error", async () => {
  await assert.rejects(readTask(undefined, Readable.from([])));
});

test("bounded stdin accepts 8192 bytes and rejects 8193", async () => {
  const full = Readable.from([Buffer.alloc(8192, 0x78)]);
  assert.equal(await readTask(undefined, full), "x".repeat(8192));
  const stdin = new PassThrough();
  const pending = readTask(undefined, stdin);
  stdin.end(Buffer.alloc(8193, 0x78));
  await assert.rejects(pending);
  assert.ok(stdin.destroyed);
});

test("split multibyte stdin decodes once at the end", async () => {
  const stdin = new PassThrough();
  const bytes = Buffer.from("界界", "utf8");
  const pending = readTask(undefined, stdin);
  stdin.write(bytes.subarray(0, 1));
  stdin.write(bytes.subarray(1));
  stdin.end();
  assert.equal(await pending, "界界");
});

test("abort stops pending pipe input", async () => {
  const stdin = new PassThrough();
  const ac = new AbortController();
  const pending = readTask(undefined, stdin, ac.signal);
  ac.abort();
  await assert.rejects(pending);
  assert.ok(stdin.destroyed);
});

test("already-aborted input rejects and destroys stdin", async () => {
  const stdin = new PassThrough();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(readTask(undefined, stdin, ac.signal));
  assert.ok(stdin.destroyed);
});
