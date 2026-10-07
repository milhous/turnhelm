import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as codex from "../src/codex.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// The legacy turnhelm route/codex dispatch (buildCodexArgs, codexEnvironment,
// runCodex over the classifier RouteDecision) was removed with the project
// task entry; the CLI parses only init, doctor, and run. The worker contract
// under the new TaskDecision path — argument construction, secret-stripped
// child environments, spawn/protocol/output failure categories, group
// shutdown — is pinned by worker.test.ts, whose coverage includes the
// sanitized spawn failure and descriptor-exhaustion process-error guards the
// legacy suite carried.

test("legacy route/codex worker exports no longer exist", () => {
  for (const name of ["buildCodexArgs", "codexEnvironment", "runCodex"]) {
    assert.equal(Object.hasOwn(codex, name), false, name + " must not be exported");
  }
});

test("the module surface is exactly the project worker contract", () => {
  assert.deepEqual(Object.keys(codex).sort(),
    ["buildWorkerArgs", "executeWorker", "subprocessEnvironment", "workerEnvironment"]);
});

const usageCases = [["route", "Review the boundary"], ["codex", "Review the boundary"]] as const;

for (const [command, task] of usageCases) {
  test(`the retired '${command}' command is a usage error, not a dispatch`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "turnhelm-usage-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    // Empty PATH: no executable discovery, no services, no inference.
    const env = { PATH: directory };
    await assert.rejects(
      () => execute(process.execPath, [cli, command, task], { env }),
      (error: { code?: number; stderr?: string }) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr ?? "", /usage: turnhelm init/);
        assert.doesNotMatch(error.stderr ?? "", new RegExp("turnhelm " + command));
        return true;
      });
  });
}
