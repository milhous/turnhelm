import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

// Isolate built-in interposition and bound even the original readerless-FIFO hang.
const journalChild = async (root: string, body: string, mockModules = false): Promise<void> => {
  // Node >=22.3 module mocks need this opt-in; only these owned children suppress its warnings.
  // namedExports is deprecated on newer patch lines (Node 24.x backports) before the Node 26 rename;
  // "exports" cannot replace it here because the minimum Node 22.8 ignores that spelling.
  const options = mockModules
    ? ["--experimental-test-module-mocks", "--disable-warning=ExperimentalWarning", "--no-deprecation"]
    : [];
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [...options, "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import fs from "node:fs/promises";
    import { constants, fstatSync, openSync, closeSync, readSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    import { appendRouteJournal } from ${JSON.stringify(new URL("../src/journal.js", import.meta.url).href)};
    const root = process.argv[1];
    const path = join(root, ".turnhelm", "routes.jsonl");
    const task = "PRIVATE_JOURNAL_TASK";
    const routing = { status: "failed", attempts: [], routingMs: 1 };
    const diagnostics = [];
    ${body}
  `, root], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 64 * 1024 });
  assert.equal(stdout, "");
  assert.equal(stderr, "");
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

test("a cancelled routing journals hash-only evidence without selection fields", async () => {
  const root = await journalRoot();
  try {
    const task = "Cancelled PRIVATE_JOURNAL_TASK";
    await appendRouteJournal(root, task, { status: "cancelled", attempts: [], routingMs: 1 });
    const [entry] = await readEntries(root);
    assert.equal(entry.status, "cancelled");
    assert.equal(entry.taskSha256, sha256(task));
    assert.equal(entry.taskBytes, Buffer.byteLength(task));
    assert.deepEqual(entry.attempts, []);
    assert.equal(entry.routingMs, 1);
    for (const key of ["backend", "profileId", "model", "effort", "confidence", "task"]) {
      assert.ok(!(key in entry));
    }
    assert.ok(!(await readFile(join(root, ".turnhelm", "routes.jsonl"), "utf8")).includes(task));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("journal entries append; earlier lines are preserved", async () => {
  const root = await journalRoot();
  try {
    const path = join(root, ".turnhelm", "routes.jsonl");
    await writeFile(path, '{"earlier":true}\n');
    await chmod(path, 0o640);
    for (const choice of ["fast", "deep"]) {
      const routing = await routeTask("Explain the entry points without editing files.", fixtureConfig(), {
        env: fakeEnv, request: withReply(decisionReply(choice))
      });
      assert.ok(routing.status === "selected");
      await appendRouteJournal(root, "Explain the entry points without editing files.", routing);
    }
    const entries = await readEntries(root);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], { earlier: true });
    assert.equal(entries[1].profileId, "fast");
    assert.equal(entries[2].profileId, "deep");
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    assert.ok((await readFile(path, "utf8")).startsWith('{"earlier":true}\n'));
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

test("a regular journal replaced by a symlink after inspection cannot redirect the append", async () => {
  const root = await journalRoot();
  const outside = await mkdtemp(join(tmpdir(), "turnhelm-journal-out-"));
  try {
    await journalChild(root, `
      const outside = ${JSON.stringify(join(outside, "owned-outside-sentinel"))};
      await fs.writeFile(outside, "unchanged\\n");
      await fs.writeFile(path, "existing\\n");
      const realLstat = fs.lstat;
      fs.lstat = async (...args) => {
        const inspected = await realLstat(...args);
        assert.ok(inspected.isFile());
        await fs.unlink(path);
        await fs.symlink(outside, path);
        return inspected;
      };
      syncBuiltinESMExports();
      await appendRouteJournal(root, task, routing, message => diagnostics.push(message));
      assert.equal(await fs.readFile(outside, "utf8"), "unchanged\\n");
      assert.equal(diagnostics.length, 1);
      assert.ok(!diagnostics[0].includes(task));
    `);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

for (const replacement of [false, true]) {
  test(`a ${replacement ? "regular journal replaced by a" : "static"} readerless FIFO is skipped without blocking`, async () => {
    const root = await journalRoot();
    try {
      await journalChild(root, replacement ? `
        await fs.writeFile(path, "existing\\n");
        const realLstat = fs.lstat;
        fs.lstat = async (...args) => {
          const inspected = await realLstat(...args);
          assert.ok(inspected.isFile());
          await fs.unlink(path);
          execFileSync("mkfifo", [path]);
          return inspected;
        };
        syncBuiltinESMExports();
        await appendRouteJournal(root, task, routing, message => diagnostics.push(message));
        assert.equal(diagnostics.length, 1);
        assert.ok((await realLstat(path)).isFIFO());
      ` : `
        execFileSync("mkfifo", [path]);
        await appendRouteJournal(root, task, routing, message => diagnostics.push(message));
        assert.equal(diagnostics.length, 1);
        assert.ok((await fs.lstat(path)).isFIFO());
      `);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("an opened replacement FIFO is refused and closed without writing to its reader", async () => {
  const root = await journalRoot();
  try {
    await journalChild(root, `
      await fs.writeFile(path, "existing\\n");
      const realLstat = fs.lstat;
      let reader;
      fs.lstat = async (...args) => {
        const inspected = await realLstat(...args);
        await fs.unlink(path);
        execFileSync("mkfifo", [path]);
        reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
        return inspected;
      };
      const realOpen = fs.open;
      let fd;
      fs.open = async (...args) => {
        const handle = await realOpen(...args);
        fd = handle.fd;
        return handle;
      };
      syncBuiltinESMExports();
      try {
        await appendRouteJournal(root, task, routing, message => diagnostics.push(message));
        assert.equal(diagnostics.length, 1);
        assert.equal(typeof fd, "number");
        assert.throws(() => fstatSync(fd), { code: "EBADF" });
        assert.equal(readSync(reader, Buffer.alloc(1024), 0, 1024, null), 0);
      } finally {
        closeSync(reader);
      }
    `);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const flag of ["O_NOFOLLOW", "O_NONBLOCK"]) {
  for (const value of ["missing", "zero"]) {
    test(`a ${value} ${flag} refuses journal append without an unsafe open`, async () => {
      const root = await journalRoot();
      try {
        await journalChild(root, `
          const sentinel = Buffer.from("owned journal sentinel\\n");
          await fs.writeFile(path, sentinel);
          const unavailable = { ...constants };
          ${value === "missing" ? `delete unavailable.${flag};` : `unavailable.${flag} = 0;`}
          const { mock } = await import("node:test");
          // Node 26 renamed namedExports; the minimum Node 22.8 still needs it.
          const exports = { constants: unavailable };
          mock.module("node:fs", Number(process.versions.node.split(".")[0]) >= 26 ? { exports } : { namedExports: exports });
          const { appendRouteJournal: guardedAppend } = await import(${JSON.stringify(new URL("../src/journal.js?unavailable-flag", import.meta.url).href)});
          const realOpen = fs.open;
          let opens = 0;
          let writes = 0;
          fs.open = async (...args) => {
            opens++;
            const handle = await realOpen(...args);
            const realAppend = handle.appendFile.bind(handle);
            handle.appendFile = async (...args) => { writes++; return realAppend(...args); };
            return handle;
          };
          syncBuiltinESMExports();
          await guardedAppend(root, task, routing, message => diagnostics.push(message));
          assert.equal(opens, 0, "unsafe journal open must never be attempted");
          assert.equal(writes, 0);
          assert.deepEqual(diagnostics, ["the route journal could not be appended; continuing without it."]);
          assert.deepEqual(await fs.readFile(path), sentinel);
        `, true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

for (const failure of ["none", "stat", "appendFile", "close"]) {
  test(`the journal closes its opened descriptor after ${failure === "none" ? "success" : failure + " failure"}`, async () => {
    const root = await journalRoot();
    try {
      await journalChild(root, `
        await fs.writeFile(path, "existing\\n");
        const realOpen = fs.open;
        let fd;
        fs.open = async (...args) => {
          const handle = await realOpen(...args);
          fd = handle.fd;
          const failure = ${JSON.stringify(failure)};
          if (failure === "close") {
            const realClose = handle.close.bind(handle);
            handle.close = async () => { await realClose(); throw new Error(task); };
          } else if (failure !== "none") {
            handle[failure] = async () => { throw new Error(task); };
          }
          return handle;
        };
        syncBuiltinESMExports();
        await appendRouteJournal(root, task, routing, message => diagnostics.push(message));
        assert.equal(typeof fd, "number");
        assert.throws(() => fstatSync(fd), { code: "EBADF" });
        assert.equal(diagnostics.length, ${failure === "none" ? 0 : 1});
        assert.ok(diagnostics.every(message => !message.includes(task)));
        const text = await fs.readFile(path, "utf8");
        assert.ok(text.startsWith("existing\\n"));
        assert.equal(text.includes('"taskSha256"'), ${failure === "none" || failure === "close"});
        assert.ok(!text.includes(task));
      `);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
