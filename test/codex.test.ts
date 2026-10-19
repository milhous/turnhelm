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
    ["ENV_BOUNDARY_TAG", "SANDBOX_SEMANTICS_NOTE", "buildWorkerArgs", "discoverWorkerCredential", "executeWorker", "subprocessEnvironment", "workerEnvironment"]);
});

const usageCases = [["route", "Review the boundary"], ["codex", "Review the boundary"]] as const;

// The frozen host-pointer scrub contract: data/config/credential discovery
// pointers and action-capable pointers die at the worker boundary; unlisted
// variables — including case variants of keys with no case rule — pass through.
const HOST_POINTERS: Readonly<Record<string, string>> = {
  AWS_CONFIG_FILE: "/tmp/host-pointer-canary/aws-config",
  AWS_SHARED_CREDENTIALS_FILE: "/tmp/host-pointer-canary/aws-credentials",
  AWS_WEB_IDENTITY_TOKEN_FILE: "/tmp/host-pointer-canary/aws-web-identity",
  DOCKER_CERT_PATH: "/tmp/host-pointer-canary/docker-certs",
  DOCKER_CONFIG: "/tmp/host-pointer-canary/docker-config",
  DOCKER_CONTEXT: "host-canary-context",
  DOCKER_HOST: "unix:///tmp/host-pointer-canary/docker.sock",
  GIT_CONFIG: "/tmp/host-pointer-canary/git-config",
  GIT_CONFIG_GLOBAL: "/tmp/host-pointer-canary/.gitconfig",
  GIT_CONFIG_SYSTEM: "/tmp/host-pointer-canary/gitconfig-system",
  KUBECONFIG: "/tmp/host-pointer-canary/kubeconfig",
  NPM_CONFIG_GLOBALCONFIG: "/tmp/host-pointer-canary/npmrc-global",
  NPM_CONFIG_USERCONFIG: "/tmp/host-pointer-canary/.npmrc",
  SSH_AUTH_SOCK: "/tmp/host-pointer-canary/agent.sock",
  XDG_CACHE_HOME: "/tmp/host-pointer-canary/cache",
  XDG_CONFIG_DIRS: "/tmp/host-pointer-canary/config-dirs",
  XDG_CONFIG_HOME: "/tmp/host-pointer-canary/config",
  XDG_DATA_DIRS: "/tmp/host-pointer-canary/data-dirs",
  XDG_DATA_HOME: "/tmp/host-pointer-canary/data",
  XDG_RUNTIME_DIR: "/tmp/host-pointer-canary/run",
  XDG_STATE_HOME: "/tmp/host-pointer-canary/state"
};
// npm documents case-insensitive environment configuration for both settings,
// so the two npm keys are the only ones with a case rule — each key pinned in
// both lowercase and mixed-case forms, planted simultaneously.
const NPM_CASE_VARIANTS: Readonly<Record<string, string>> = {
  npm_config_userconfig: "/tmp/host-pointer-canary/.npmrc-user-lower",
  npm_config_globalconfig: "/tmp/host-pointer-canary/npmrc-global-lower",
  Npm_Config_UserConfig: "/tmp/host-pointer-canary/.npmrc-user-mixed",
  Npm_Config_GlobalConfig: "/tmp/host-pointer-canary/npmrc-global-mixed"
};

test("workerEnvironment deletes every frozen host-pointer key and npm case variant", () => {
  const env = codex.workerEnvironment({
    ...HOST_POINTERS,
    ...NPM_CASE_VARIANTS,
    ssh_auth_sock: "/tmp/host-pointer-canary/agent-lower.sock",
    AWS_CA_BUNDLE: "/tmp/host-pointer-canary/aws-ca-bundle",
    XDG_SENTINEL: "/tmp/host-pointer-canary/xdg-sentinel",
    PATH: "/bin",
    SHELL: "/bin/zsh",
    TMPDIR: "/tmp",
    OPENAI_API_KEY: "test-openai-key",
    NODE_OPTIONS: "--max-old-space-size=1",
    LAYA_API_KEY: "TEST_LAYA_SENTINEL",
    TYPESAFE_API_KEY: "TEST_JEV_SENTINEL",
    TURNHELM_ALLOW_HOSTED_JEV: "1",
    TURNHELM_CONFIG: "/tmp/turnhelm.json",
    BASH_ENV: "/tmp/host-bashenv",
    ENV: "/tmp/host-shenv",
    HOME: "/tmp/host-home",
    CODEX_HOME: "/tmp/host-codex",
    ZDOTDIR: "/tmp/host-zdotdir"
  }, "/managed/home");
  for (const key of [...Object.keys(HOST_POINTERS), ...Object.keys(NPM_CASE_VARIANTS)]) {
    assert.equal(Object.hasOwn(env, key), false, key + " is scrubbed at the worker boundary");
  }
  // Precision: unlisted keys — including a lowercase variant of a key with no
  // case rule — pass through with their values.
  assert.equal(env.ssh_auth_sock, "/tmp/host-pointer-canary/agent-lower.sock");
  assert.equal(env.AWS_CA_BUNDLE, "/tmp/host-pointer-canary/aws-ca-bundle");
  assert.equal(env.XDG_SENTINEL, "/tmp/host-pointer-canary/xdg-sentinel");
  assert.equal(env.PATH, "/bin");
  assert.equal(env.SHELL, "/bin/zsh");
  assert.equal(env.TMPDIR, "/tmp");
  assert.equal(env.OPENAI_API_KEY, "test-openai-key");
  assert.equal(env.NODE_OPTIONS, "--max-old-space-size=1");
  // The credential strip and managed overrides still hold.
  assert.equal(env.LAYA_API_KEY, undefined);
  assert.equal(env.TYPESAFE_API_KEY, undefined);
  assert.equal(env.TURNHELM_ALLOW_HOSTED_JEV, undefined);
  assert.equal(env.TURNHELM_CONFIG, undefined);
  assert.equal(env.BASH_ENV, undefined);
  assert.equal(env.ENV, undefined);
  assert.equal(env.HOME, "/managed/home");
  assert.equal(env.ZDOTDIR, "/managed/home");
  assert.equal(env.CODEX_HOME, "/managed/home");
  assert.equal(env.TURNHELM_MANAGED_CHILD, "1");
});

test("subprocessEnvironment leaves the frozen host-pointer list alone", () => {
  const env = codex.subprocessEnvironment({ ...HOST_POINTERS, PATH: "/bin" });
  for (const [key, value] of Object.entries(HOST_POINTERS)) {
    assert.equal(env[key], value, key + " still passes the classifier-facing boundary");
  }
  assert.equal(env.PATH, "/bin");
});

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
