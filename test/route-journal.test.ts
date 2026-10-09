import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestTaskChoice } from "../src/systemone.js";
import { routeTask } from "../src/route.js";
import { appendRouteJournal } from "../src/journal.js";
import { decisionReply, fakeEnv, fixtureConfig } from "./fixtures.js";

const withReply = (reply: unknown) => async (): Promise<unknown> => reply;

const sha256 = (task: string): string => createHash("sha256").update(task).digest("hex");

const journalRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "turnhelm-journal-"));
  await mkdir(join(root, ".turnhelm"));
  return root;
};

const readEntries = async (root: string): Promise<Record<string, unknown>[]> => {
  const text = await readFile(join(root, ".turnhelm", "routes.jsonl"), "utf8");
  return text.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
};

test("requestTaskChoice returns the selected profile with the classifier confidence", async () => {
  const choice = await requestTaskChoice(fixtureConfig(), "Summarize the routing module.", "laya", fakeEnv,
    new AbortController().signal,
    withReply({ answers: { route: { type: "choice", choice: "fast", confidence: 0.87 } } }));
  assert.deepEqual(choice, { profileId: "fast", confidence: 0.87 });
});

test("a missing or out-of-range confidence is tolerated as absent", async () => {
  const replies = [
    decisionReply("fast"),
    { answers: { route: { type: "choice", choice: "fast", confidence: "high" } } },
    { answers: { route: { type: "choice", choice: "fast", confidence: 1.5 } } }
  ];
  for (const reply of replies) {
    const choice = await requestTaskChoice(fixtureConfig(), "Summarize the routing module.", "laya", fakeEnv,
      new AbortController().signal, withReply(reply));
    assert.equal(choice.profileId, "fast");
    assert.equal(choice.confidence, undefined);
  }
});

test("routeTask carries the classifier confidence into the decision", async () => {
  const routing = await routeTask("Prove the coupled transaction invariants", fixtureConfig(), {
    env: fakeEnv,
    request: withReply({ answers: { route: { type: "choice", choice: "frontier_max", confidence: 0.64 } } })
  });
  assert.ok(routing.status === "selected");
  assert.equal(routing.decision.confidence, 0.64);
});

test("a selected routing appends one JSON line of route evidence", async () => {
  const root = await journalRoot();
  try {
    const task = "Explain the entry points without editing files.";
    const routing = await routeTask(task, fixtureConfig(), {
      env: fakeEnv,
      request: withReply({ answers: { route: { type: "choice", choice: "balanced", confidence: 0.81 } } })
    });
    assert.ok(routing.status === "selected");
    await appendRouteJournal(root, task, routing);
    const [entry] = await readEntries(root);
    assert.equal(entry.type, "turnhelm.route");
    assert.equal(entry.status, "selected");
    assert.equal(entry.taskSha256, sha256(task));
    assert.equal(entry.taskBytes, Buffer.byteLength(task));
    assert.equal(entry.backend, "laya");
    assert.equal(entry.profileId, "balanced");
    assert.equal(entry.model, "gpt-6.1-sol");
    assert.equal(entry.effort, "medium");
    assert.equal(entry.confidence, 0.81);
    assert.equal(typeof entry.routingMs, "number");
    assert.ok(Array.isArray(entry.attempts) && entry.attempts.length > 0);
    assert.equal(typeof entry.ts, "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed routing journals attempts without selection fields", async () => {
  const root = await journalRoot();
  try {
    const task = "Fix cache invalidation.";
    const routing = await routeTask(task, fixtureConfig(), {
      env: fakeEnv,
      request: async () => { throw new Error("TEST_PRIVATE_SENTINEL"); }
    });
    assert.equal(routing.status, "failed");
    await appendRouteJournal(root, task, routing);
    const [entry] = await readEntries(root);
    assert.equal(entry.type, "turnhelm.route");
    assert.equal(entry.status, "failed");
    assert.ok(Array.isArray(entry.attempts) && entry.attempts.length > 0);
    for (const key of ["backend", "profileId", "model", "effort", "confidence"]) {
      assert.ok(!(key in entry), key + " must not appear on a failed routing");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal entries append; earlier lines are preserved", async () => {
  const root = await journalRoot();
  try {
    for (const choice of ["fast", "deep"]) {
      const routing = await routeTask("Explain the entry points without editing files.", fixtureConfig(), {
        env: fakeEnv, request: withReply(decisionReply(choice))
      });
      assert.ok(routing.status === "selected");
      await appendRouteJournal(root, "Explain the entry points without editing files.", routing);
    }
    const entries = await readEntries(root);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].profileId, "fast");
    assert.equal(entries[1].profileId, "deep");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the raw task text never appears in the journal", async () => {
  const root = await journalRoot();
  try {
    const task = "Summarize ROUTE_JOURNAL_SENTINEL_9c2f handling across modules.";
    const routing = await routeTask(task, fixtureConfig(), {
      env: fakeEnv, request: withReply(decisionReply("fast"))
    });
    assert.ok(routing.status === "selected");
    await appendRouteJournal(root, task, routing);
    const text = await readFile(join(root, ".turnhelm", "routes.jsonl"), "utf8");
    assert.ok(!text.includes("ROUTE_JOURNAL_SENTINEL_9c2f"), "task text must not be journaled");
    assert.ok(text.includes(sha256(task)), "the task hash must identify the journaled task");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a journal write failure is diagnosed and never fails the run", async () => {
  const root = await journalRoot();
  try {
    // routes.jsonl as a directory makes every append fail with EISDIR.
    await mkdir(join(root, ".turnhelm", "routes.jsonl"));
    const routing = await routeTask("Explain the entry points without editing files.", fixtureConfig(), {
      env: fakeEnv, request: withReply(decisionReply("fast"))
    });
    assert.ok(routing.status === "selected");
    const diagnostics: string[] = [];
    await appendRouteJournal(root, "Explain the entry points without editing files.", routing,
      message => diagnostics.push(message));
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /journal/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked journal path is refused, never written through", async () => {
  const root = await journalRoot();
  const outside = await mkdtemp(join(tmpdir(), "turnhelm-journal-out-"));
  try {
    const target = join(outside, "routes.jsonl");
    await writeFile(target, "existing\n");
    await symlink(target, join(root, ".turnhelm", "routes.jsonl"));
    const routing = await routeTask("Explain the entry points without editing files.", fixtureConfig(), {
      env: fakeEnv, request: withReply(decisionReply("fast"))
    });
    assert.ok(routing.status === "selected");
    const diagnostics: string[] = [];
    await appendRouteJournal(root, "Explain the entry points without editing files.", routing,
      message => diagnostics.push(message));
    assert.equal(await readFile(target, "utf8"), "existing\n");
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /journal/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
