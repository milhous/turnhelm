import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { readProjectConfig, type ProjectConfig } from "./config.js";
import { readTemplates, type Templates } from "./assets.js";
import { inspectInstallation } from "./init.js";
import { readProjectFile } from "./project.js";
import { readCodexSignals } from "./models.js";
import { inspectCodex, inspectGit } from "./preflight.js";
import { eligibleBackends, requestTaskChoice, type ChoiceRequest, type TaskBackend } from "./systemone.js";

export type CheckStatus = "pass" | "warn" | "fail" | "unverified" | "skipped";

export type DoctorCheck = Readonly<{ id: string; status: CheckStatus; evidence: string; next: string }>;

export type DoctorResult = Readonly<{ code: 0 | 1; checks: readonly DoctorCheck[] }>;

// `probe` is optional-with-false: the brief's "Default probe=false" cannot be
// expressed by the plan-frozen required `probe: boolean` without breaking
// Task 6 callers, so this is a source-compatible widening of that shape.
export type DoctorOptions = Readonly<{
  probe?: boolean;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  request?: ChoiceRequest;
}>;

const NODE_FLOOR: readonly [number, number, number] = [22, 8, 0];
// Fixed synthetic task: probes only prove the classification round trip works;
// the answer is never used for routing here.
const PROBE_TASK = "turnhelm doctor readiness probe: reply with the lightest eligible route.";

const SKILL_MD_RELATIVE = ".agents/skills/turnhelm-routing/SKILL.md";
const SKILL_YAML_RELATIVE = ".agents/skills/turnhelm-routing/agents/openai.yaml";
const AGENTS_RELATIVE = "AGENTS.md";
const AGENTS_OVERRIDE_RELATIVE = "AGENTS.override.md";
const MARKER_BEGIN = "<!-- turnhelm:begin v1 -->";
const MARKER_END = "<!-- turnhelm:end -->";
const MAX_TARGET_BYTES = 65536;
const MAX_AGENTS_BYTES = 1048576;

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

// Fixed, sanitized probe outcome; the injected request's error text is never
// surfaced and nothing about the probe is persisted.
type ProbeOutcome = "completed" | "failed" | "cancelled";

// The probe travels the validated single-backend choice boundary: it sends
// the real six-criteria request with instructions and only a valid choice
// envelope (type "choice", an approved profile id) can complete it (E4).
async function runProbe(
  backend: TaskBackend,
  config: ProjectConfig,
  env: NodeJS.ProcessEnv,
  request: ChoiceRequest,
  callerSignal: AbortSignal | undefined
): Promise<ProbeOutcome> {
  if (callerSignal?.aborted) return "cancelled";
  // Each probe owns its controller so one configured budget and the caller's
  // signal cancel this request alone; a misbehaving request is raced by the
  // budget so the doctor always terminates (E7).
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const started = Date.now();
  const budget = setTimeout(() => controller.abort(), config.routingTimeoutMs);
  // The race keeps the doctor bounded even when an injected request ignores
  // its signal and never settles.
  const bounded = new Promise<"failed" | "cancelled">(resolve => {
    controller.signal.addEventListener("abort", () => resolve(callerSignal?.aborted ? "cancelled" : "failed"), { once: true });
  });
  try {
    const attempted = requestTaskChoice(config, PROBE_TASK, backend, env, controller.signal, request)
      .then(() => "completed" as const, (): ProbeOutcome => "failed");
    const outcome = await Promise.race([attempted, bounded]);
    if (outcome === "failed" && callerSignal?.aborted) return "cancelled";
    if (outcome === "completed") {
      // Recheck the caller and a monotonic deadline before settling success:
      // the budget timer cannot run while a busy request blocks the loop (E7).
      if (callerSignal?.aborted) return "cancelled";
      if (Date.now() - started > config.routingTimeoutMs) return "failed";
    }
    return outcome;
  } finally {
    clearTimeout(budget);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

const PROBE_STATUS: Record<ProbeOutcome, { status: CheckStatus; evidence: string }> = {
  completed: { status: "pass", evidence: "synthetic classification probe completed with a valid choice envelope" },
  failed: { status: "fail", evidence: "synthetic classification probe did not complete with a valid choice within its budget" },
  cancelled: { status: "unverified", evidence: "synthetic classification probe was cancelled" }
};

async function readTarget(root: string, relative: string, max: number): Promise<Buffer | undefined | "unreadable"> {
  try {
    return await readProjectFile(root, relative, max);
  } catch {
    return "unreadable";
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let at = text.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = text.indexOf(needle, at + needle.length);
  }
  return count;
}

// Mirrors the installer's managed-block conflict conditions (read-only) so a
// degraded-path evaluation agrees with what `turnhelm init` would enforce.
function agentsBlockConflict(text: string, block: string): boolean {
  const beginCount = countOccurrences(text, MARKER_BEGIN);
  const endCount = countOccurrences(text, MARKER_END);
  if (beginCount === 0 && endCount === 0) return false; // init appends the block
  if (beginCount !== 1 || endCount !== 1) return true;
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);
  if (begin > end) return true;
  const current = text.slice(begin, end + MARKER_END.length);
  return current !== block && current !== block.replaceAll("\n", "\r\n");
}

type InstallFindings = Readonly<{ assets: DoctorCheck; instructions: DoctorCheck }>;

// Each install target is derived from its own local read-only facts, so one
// target's conflict never un-verifies the others (E5).
async function independentFindings(root: string, templates: Templates): Promise<InstallFindings> {
  const [skill, metadata] = await Promise.all([
    readTarget(root, SKILL_MD_RELATIVE, MAX_TARGET_BYTES),
    readTarget(root, SKILL_YAML_RELATIVE, MAX_TARGET_BYTES)
  ]);
  const assets = skill === "unreadable" || metadata === "unreadable"
    ? check("assets", "unverified", "routing skill files could not be read safely", "inspect .agents/skills/turnhelm-routing, then re-run turnhelm doctor")
    : skill === undefined || metadata === undefined
      ? check("assets", "warn", "routing skill files are not installed", "run turnhelm init")
      : !skill.equals(templates.skill) || !metadata.equals(templates.metadata)
        ? check("assets", "fail", "routing skill files differ from the owned template", "restore the owned skill files or remove them, then run turnhelm init")
        : check("assets", "pass", "routing skill files match the owned template", "");
  const agents = await readTarget(root, AGENTS_RELATIVE, MAX_AGENTS_BYTES);
  const instructions = agents === "unreadable"
    ? check("instructions", "unverified", "AGENTS.md could not be read safely", "inspect AGENTS.md, then re-run turnhelm doctor")
    : agents === undefined
      ? check("instructions", "warn", "AGENTS.md managed routing block is not installed", "run turnhelm init")
      : agentsBlockConflict(agents.toString("utf8"), templates.agentsBlock)
        ? check("instructions", "fail", "AGENTS.md managed block conflicts with the installed template", "restore the managed block or remove the conflicting markers, then run turnhelm init")
        : check("instructions", "pass", "AGENTS.md managed routing block is installed", "");
  return { assets, instructions };
}

async function installFindings(root: string): Promise<InstallFindings> {
  let templates: Templates;
  try {
    templates = await readTemplates();
  } catch {
    return {
      assets: check("assets", "fail", "shipped turnhelm templates are unavailable", "reinstall turnhelm"),
      instructions: check("instructions", "fail", "shipped turnhelm templates are unavailable", "reinstall turnhelm")
    };
  }
  let findings: InstallFindings;
  try {
    const changes = await inspectInstallation(root, templates);
    const planned = new Set(changes.map(change => change.path));
    findings = {
      assets: planned.has(SKILL_MD_RELATIVE) || planned.has(SKILL_YAML_RELATIVE)
        ? check("assets", "warn", "routing skill files are not installed", "run turnhelm init")
        : check("assets", "pass", "routing skill files match the owned template", ""),
      instructions: planned.has(AGENTS_RELATIVE)
        ? check("instructions", "warn", "AGENTS.md managed routing block is not installed", "run turnhelm init")
        : check("instructions", "pass", "AGENTS.md managed routing block is installed", "")
    };
  } catch {
    // The shared inspection stops at its first conflict; the remaining targets
    // are still independently inspectable, so re-derive each finding from
    // local read-only facts instead of failing the siblings (E5).
    findings = await independentFindings(root, templates);
  }
  if (findings.instructions.status === "pass"
    && await readTarget(root, AGENTS_OVERRIDE_RELATIVE, MAX_AGENTS_BYTES) !== undefined) {
    // E8: an override file is an ascertainable discovery restriction; which
    // instructions Codex actually discovers cannot be verified offline.
    findings = {
      assets: findings.assets,
      instructions: check("instructions", "unverified",
        "root AGENTS.override.md sits beside AGENTS.md; which instructions Codex discovers cannot be verified offline",
        "remove or reconcile AGENTS.override.md, then re-run turnhelm doctor")
    };
  }
  return findings;
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

  // codex + git (bounded non-inference CLI evidence only). E8: help output is
  // flag evidence, never proof of runtime config-key semantics.
  const codex = await inspectCodex(root, env, options.signal);
  checks.push(codex.ok
    ? check("codex", "pass", "codex " + (codex.version ?? "") + " advertises the required CLI controls; agents.enabled and other client config-key semantics remain unresolved from help output alone", "")
    : check("codex", "fail", "codex CLI is missing, too old, malformed, or lacks required controls", "install codex 0.160.0 or newer and verify `codex exec --help` lists --json, --ephemeral, --sandbox, and stdin"));
  const git = await inspectGit(root, env, options.signal);
  checks.push(git.ok
    ? check("git", "pass", "project root is inside a Git work tree", "")
    : check("git", "warn", "project root is not inside a Git work tree (or git is unavailable)", "run from a Git work tree for workspace-write safety"));

  // config (missing vs invalid comes from the filesystem fact, not error prose)
  let config: ProjectConfig | undefined;
  let configProblem: "missing" | "invalid" | undefined;
  try {
    config = await readProjectConfig(root);
  } catch {
    configProblem = existsSync(join(root, ".turnhelm", "config.json")) ? "invalid" : "missing";
  }

  // assets via read-only installation inspection (instructions is reported
  // later, at its stable position in the check order)
  const install = await installFindings(root);
  checks.push(install.assets);

  checks.push(configProblem === undefined
    ? check("config", "pass", ".turnhelm/config.json parsed as a v1 project config", "")
    : configProblem === "missing"
      ? check("config", "fail", ".turnhelm/config.json is missing", "run turnhelm init")
      : check("config", "fail", ".turnhelm/config.json is not a valid v1 project config", "fix or remove .turnhelm/config.json, then run turnhelm init"));

  // backends
  const eligible = config ? eligibleBackends(config, env) : [];
  checks.push(config === undefined
    ? check("backends", "skipped", "backend eligibility needs a valid project config", "fix the project config, then re-run turnhelm doctor")
    : eligible.length > 0
      ? check("backends", "pass", eligible.length + " eligible backend(s)", "")
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
  checks.push(install.instructions);

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
  // E6: eligibility is not readiness — only an explicit probe verifies the
  // classification round trip; an enabled-but-unauthorized backend is skipped.
  if (!eligibleBackends(config, env).includes(backend)) {
    return check(id, "skipped", "enabled but missing credentials or hosted opt-in", "provide TYPESAFE_API_KEY and set TURNHELM_ALLOW_HOSTED_JEV=1");
  }
  if (options.probe !== true) {
    return check(id, "unverified", "enabled and eligible offline; reachability, authentication, and model access are unverified without --probe", "run turnhelm doctor --probe to verify the classification round trip");
  }
  if (options.request === undefined) {
    return check(id, "unverified", "probe mode requested but no probe request was provided", "pass an injected probe request to verify the round trip");
  }
  const outcome = await runProbe(backend, config, env, options.request, options.signal);
  const probed = PROBE_STATUS[outcome];
  return check(id, probed.status, probed.evidence, probed.status === "pass" ? "" : "check backend connectivity and credentials, then re-run turnhelm doctor --probe");
}
