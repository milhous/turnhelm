import { realpathSync, statSync } from "node:fs";
import { readProjectConfig, type ProjectConfig } from "./config.js";
import { readTemplates, TemplateError } from "./assets.js";
import { inspectInstallation } from "./init.js";
import { readCodexSignals } from "./models.js";
import { inspectCodex, inspectGit } from "./preflight.js";
import type { ChoiceRequest, RequestSpec, TaskBackend } from "./systemone.js";

export type CheckStatus = "pass" | "warn" | "fail" | "unverified" | "skipped";

export type DoctorCheck = Readonly<{ id: string; status: CheckStatus; evidence: string; next: string }>;

export type DoctorResult = Readonly<{ code: 0 | 1; checks: readonly DoctorCheck[] }>;

export type DoctorOptions = Readonly<{
  probe?: boolean;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  request?: ChoiceRequest;
}>;

const NODE_FLOOR: readonly [number, number, number] = [22, 8, 0];
const JEV_BASE_URL = "https://api.typesafe.ai";
// Fixed synthetic task: probes only prove the classification round trip works;
// the answer is never used for routing here.
const PROBE_TASK = "turnhelm doctor readiness probe: reply with the lightest eligible route.";

const check = (id: string, status: CheckStatus, evidence: string, next: string): DoctorCheck =>
  ({ id, status, evidence, next });

function present(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function numericVersion(text: string): readonly [number, number, number] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}

function atLeast(tuple: readonly number[], floor: readonly number[]): boolean {
  for (let index = 0; index < floor.length; index++) {
    if (tuple[index] !== floor[index]) return (tuple[index] ?? 0) > floor[index];
  }
  return true;
}

function jevEligible(config: ProjectConfig, env: NodeJS.ProcessEnv): boolean {
  return config.backends.jev.enabled && env.TURNHELM_ALLOW_HOSTED_JEV === "1" && present(env.TYPESAFE_API_KEY);
}

// Fixed, sanitized probe outcome; the injected request's error text is never
// surfaced and nothing about the probe is persisted.
type ProbeOutcome = "completed" | "failed" | "cancelled";

function runProbe(
  backend: TaskBackend,
  config: ProjectConfig,
  env: NodeJS.ProcessEnv,
  request: ChoiceRequest,
  callerSignal: AbortSignal | undefined
): Promise<ProbeOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budget);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      resolve(outcome);
    };
    // Each probe owns its controller so one configured budget and the caller's
    // signal cancel this request alone; a misbehaving request is raced by the
    // budget so the doctor always terminates.
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) controller.abort();
    const budget = setTimeout(() => controller.abort(), config.routingTimeoutMs);
    const key = backend === "jev" ? env.TYPESAFE_API_KEY : env.LAYA_API_KEY;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (present(key)) headers.authorization = "Bearer " + key;
    const spec: RequestSpec = {
      backend,
      url: new URL("/v1/systemone", backend === "jev" ? JEV_BASE_URL : config.backends.laya.url),
      body: JSON.stringify({
        state: PROBE_TASK,
        model: backend === "jev" ? "jev-latest" : "typed-decisions",
        questions: { route: { type: "choice" } }
      }),
      headers,
      signal: controller.signal
    };
    if (controller.signal.aborted) return finish("cancelled");
    const outcome = (): ProbeOutcome => callerSignal?.aborted ? "cancelled" : "failed";
    controller.signal.addEventListener("abort", () => finish(outcome()), { once: true });
    request(spec).then(
      () => finish("completed"),
      () => { if (!settled) finish(outcome()); }
    );
  });
}

const PROBE_STATUS: Record<ProbeOutcome, { status: CheckStatus; evidence: string }> = {
  completed: { status: "pass", evidence: "synthetic classification probe completed" },
  failed: { status: "fail", evidence: "synthetic classification probe did not complete within its budget" },
  cancelled: { status: "unverified", evidence: "synthetic classification probe was cancelled" }
};

function classifyInspection(planned: readonly string[] | undefined, conflict: string | undefined):
  { assets: DoctorCheck; instructions: DoctorCheck } {
  if (conflict !== undefined) {
    if (conflict.startsWith(".turnhelm/config.json")) {
      const evidence = "installation inspection stopped on an invalid project config";
      const next = "fix .turnhelm/config.json, then run turnhelm init";
      return { assets: check("assets", "unverified", evidence, next), instructions: check("instructions", "unverified", evidence, next) };
    }
    if (conflict.startsWith("AGENTS.md")) {
      return {
        assets: check("assets", "unverified", "installation inspection stopped before the skill check", "resolve the AGENTS.md conflict, then re-run turnhelm doctor"),
        instructions: check("instructions", "fail", "AGENTS.md managed block conflicts with the installed template", "restore the managed block or remove the conflicting markers, then run turnhelm init")
      };
    }
    return {
      assets: check("assets", "fail", "routing skill files differ from the owned template", "restore the owned skill files or remove them, then run turnhelm init"),
      instructions: check("instructions", "unverified", "installation inspection stopped before the AGENTS.md check", "resolve the skill conflict, then re-run turnhelm doctor")
    };
  }
  const plannedSet = new Set(planned ?? []);
  const skillPlanned = plannedSet.has(".agents/skills/turnhelm-routing/SKILL.md")
    || plannedSet.has(".agents/skills/turnhelm-routing/agents/openai.yaml");
  return {
    assets: skillPlanned
      ? check("assets", "warn", "routing skill files are not installed", "run turnhelm init")
      : check("assets", "pass", "routing skill files match the owned template", ""),
    instructions: plannedSet.has("AGENTS.md")
      ? check("instructions", "warn", "AGENTS.md managed routing block is not installed", "run turnhelm init")
      : check("instructions", "pass", "AGENTS.md managed routing block is installed", "")
  };
}

export async function doctorProject(root: string, options: DoctorOptions): Promise<DoctorResult> {
  const env = options.env;
  const checks: DoctorCheck[] = [];

  // root
  try {
    if (!statSync(realpathSync(root)).isDirectory()) throw new Error();
    checks.push(check("root", "pass", "project root is a directory", ""));
  } catch {
    checks.push(check("root", "fail", "project root is not a readable directory", "run turnhelm doctor from an existing project directory"));
  }

  // node
  const node = numericVersion(process.versions.node);
  checks.push(atLeast(node, NODE_FLOOR)
    ? check("node", "pass", "node " + node.join(".") + " satisfies the supported range", "")
    : check("node", "fail", "node " + node.join(".") + " is below the supported range", "upgrade node to 22.8.0 or newer"));

  // codex + git (bounded non-inference CLI evidence only)
  const codex = await inspectCodex(root, env, options.signal);
  checks.push(codex.ok
    ? check("codex", "pass", "codex " + (codex.version ?? "") + " supports the required controls", "")
    : check("codex", "fail", "codex CLI is missing, too old, malformed, or lacks required controls", "install codex 0.160.0 or newer and verify `codex exec --help` lists --json, --ephemeral, --sandbox, and stdin"));
  const git = await inspectGit(root, env, options.signal);
  checks.push(git.ok
    ? check("git", "pass", "project root is inside a Git work tree", "")
    : check("git", "warn", "project root is not inside a Git work tree (or git is unavailable)", "run from a Git work tree for workspace-write safety"));

  // assets via read-only installation inspection (instructions is reported
  // later, at its stable position in the check order)
  let instructions: DoctorCheck;
  try {
    const templates = await readTemplates();
    const changes = await inspectInstallation(root, templates);
    const classified = classifyInspection(changes.map(change => change.path), undefined);
    const assets = classified.assets;
    instructions = classified.instructions;
    checks.push(assets);
  } catch (error) {
    if (error instanceof TemplateError) {
      checks.push(check("assets", "fail", "shipped turnhelm templates are unavailable", "reinstall turnhelm"));
      instructions = check("instructions", "fail", "shipped turnhelm templates are unavailable", "reinstall turnhelm");
    } else {
      const classified = classifyInspection(undefined, (error as Error).message);
      checks.push(classified.assets);
      instructions = classified.instructions;
    }
  }

  // config
  let config: ProjectConfig | undefined;
  let configProblem: "missing" | "invalid" | undefined;
  try {
    config = await readProjectConfig(root);
  } catch (error) {
    configProblem = (error as Error).message.includes("missing") ? "missing" : "invalid";
  }
  checks.push(configProblem === undefined
    ? check("config", "pass", ".turnhelm/config.json parsed as a v1 project config", "")
    : configProblem === "missing"
      ? check("config", "fail", ".turnhelm/config.json is missing", "run turnhelm init")
      : check("config", "fail", ".turnhelm/config.json is not a valid v1 project config", "fix or remove .turnhelm/config.json, then run turnhelm init"));

  // backends
  const eligible = config ? eligibleCount(config, env) : 0;
  checks.push(config === undefined
    ? check("backends", "skipped", "backend eligibility needs a valid project config", "fix the project config, then re-run turnhelm doctor")
    : eligible > 0
      ? check("backends", "pass", eligible + " eligible backend(s)", "")
      : check("backends", "fail", "no eligible backend", "enable a backend in .turnhelm/config.json and provide its credentials"));

  // credentials (presence only; never values, never authentication claims)
  const layaKey = present(env.LAYA_API_KEY);
  const jevKey = present(env.TYPESAFE_API_KEY);
  const jevOptIn = env.TURNHELM_ALLOW_HOSTED_JEV === "1";
  const credentialEvidence = [
    "LAYA_API_KEY " + (layaKey ? "present" : "absent"),
    "TYPESAFE_API_KEY " + (jevKey ? "present" : "absent"),
    "hosted Jev opt-in " + (jevOptIn ? "set" : "unset")
  ].join("; ");
  checks.push(layaKey && jevKey && jevOptIn
    ? check("credentials", "pass", credentialEvidence, "")
    : check("credentials", "warn", credentialEvidence, "export the classifier credentials you intend to use"));

  // instructions (from the installation inspection above)
  checks.push(instructions);

  // models (advisory local Codex metadata; never gates selection)
  const signals = readCodexSignals(env);
  const cachedCount = Object.keys(signals.cached).length;
  checks.push(signals.defaultModel !== undefined || cachedCount > 0
    ? check("models", "pass", "local Codex model metadata available (advisory)", "")
    : check("models", "warn", "no local Codex model metadata; shipped capabilities apply (advisory)", "run codex once to populate local model metadata"));

  // backend.laya / backend.jev (probe mode only, one synthetic request each)
  checks.push(await backendCheck("laya", config, env, options));
  checks.push(await backendCheck("jev", config, env, options));

  return { code: checks.some(entry => entry.status === "fail") ? 1 : 0, checks };
}

function eligibleCount(config: ProjectConfig, env: NodeJS.ProcessEnv): number {
  let count = 0;
  if (config.backends.laya.enabled) count++;
  if (jevEligible(config, env)) count++;
  return count;
}

async function backendCheck(
  backend: TaskBackend,
  config: ProjectConfig | undefined,
  env: NodeJS.ProcessEnv,
  options: DoctorOptions
): Promise<DoctorCheck> {
  const id = "backend." + backend;
  if (config === undefined) {
    return check(id, "skipped", "backend readiness needs a valid project config", "fix the project config, then re-run turnhelm doctor");
  }
  const enabled = backend === "laya" ? config.backends.laya.enabled : config.backends.jev.enabled;
  if (!enabled) return check(id, "skipped", "disabled in project config", "enable it in .turnhelm/config.json to use this backend");
  const eligible = backend === "laya" || jevEligible(config, env);
  if (!eligible) {
    return check(id, "warn", "enabled but missing credentials or hosted opt-in", "provide TYPESAFE_API_KEY and set TURNHELM_ALLOW_HOSTED_JEV=1");
  }
  if (options.probe !== true) {
    return check(id, "pass", "enabled and eligible (offline readiness only)", "run turnhelm doctor --probe to verify the classification round trip");
  }
  if (options.request === undefined) {
    return check(id, "unverified", "probe mode requested but no probe request was provided", "pass an injected probe request to verify the round trip");
  }
  const outcome = await runProbe(backend, config, env, options.request, options.signal);
  const probed = PROBE_STATUS[outcome];
  return check(id, probed.status, probed.evidence, probed.status === "pass" ? "" : "check backend connectivity and credentials, then re-run turnhelm doctor --probe");
}
