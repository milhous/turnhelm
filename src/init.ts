import { statSync } from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TemplateError, readTemplates, type Templates } from "./assets.js";
import { parseProjectConfig } from "./config.js";
import { projectPath, readProjectFile } from "./project.js";

export type ErrorCategory = "conflict" | "race" | "template" | "io";

export type Change = Readonly<{
  relative: string;
  content: Buffer;
  created: boolean;
  previous?: Readonly<{ bytes: Buffer; mode: number }>;
}>;

export type Inspection = Readonly<{ changes: readonly Change[]; planned: readonly string[] }>;

export type InstallationResult = Readonly<{
  code: 0 | 1;
  error?: ErrorCategory;
  planned: readonly string[];
  applied: readonly string[];
}>;

class InstallError extends Error {
  constructor(readonly category: ErrorCategory, message: string) {
    super(message);
  }
}

const MAX_FILE_BYTES = 65536;
const MAX_AGENTS_BYTES = 1048576;
const CONFIG_RELATIVE = ".turnhelm/config.json";
const SKILL_MD_RELATIVE = ".agents/skills/turnhelm-routing/SKILL.md";
const SKILL_YAML_RELATIVE = ".agents/skills/turnhelm-routing/agents/openai.yaml";
const AGENTS_RELATIVE = "AGENTS.md";
const MARKER_BEGIN = "<!-- turnhelm:begin v1 -->";
const MARKER_END = "<!-- turnhelm:end -->";
const MANAGED_BLOCK = [
  MARKER_BEGIN,
  "# Turnhelm routing (managed)",
  "",
  "For tasks that need a model/effort-routed Codex child, run `turnhelm run",
  '"<task>"` with one self-contained prompt stating the full task',
  "requirement. Ordinary automatic selection picks the profile, including",
  "`frontier_max` when the task genuinely needs maximum effort; there is no",
  "max-specific flag or extra stage. Workspace writes and hosted backends need",
  "separate, explicit authorization immediately before use. Never invoke",
  "`turnhelm run` from inside a Turnhelm-managed Codex child. Details:",
  "`.agents/skills/turnhelm-routing/SKILL.md`.",
  MARKER_END,
].join("\n");

type Existing = { bytes: Buffer; mode: number };

async function readExisting(root: string, relative: string, max = MAX_FILE_BYTES): Promise<Existing | undefined> {
  let path: string;
  try {
    path = projectPath(root, relative);
  } catch {
    throw new InstallError("conflict", relative + " traverses a symbolic link or non-directory");
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new InstallError("conflict", relative + " is unreadable");
  }
  if (!info.isFile()) throw new InstallError("conflict", relative + " is not a regular file");
  let bytes: Buffer | undefined;
  try {
    bytes = await readProjectFile(root, relative, max);
  } catch (error) {
    throw new InstallError("conflict", relative + " could not be read: " + (error as Error).message);
  }
  if (bytes === undefined) return undefined;
  return { bytes, mode: info.mode & 0o777 };
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

function planAgentsFrom(existing: Existing | undefined): Change | undefined {
  if (existing === undefined) {
    return { relative: AGENTS_RELATIVE, content: Buffer.from(MANAGED_BLOCK + "\n"), created: true };
  }
  const text = existing.bytes.toString("utf8");
  const beginCount = countOccurrences(text, MARKER_BEGIN);
  const endCount = countOccurrences(text, MARKER_END);
  if (!(beginCount === 0 && endCount === 0) && (beginCount !== 1 || endCount !== 1)) {
    throw new InstallError("conflict", AGENTS_RELATIVE + " managed markers are duplicated or unbalanced");
  }
  const crlf = text.includes("\r\n");
  const newline = crlf ? "\r\n" : "\n";
  const block = crlf ? MANAGED_BLOCK.replaceAll("\n", "\r\n") : MANAGED_BLOCK;
  if (beginCount === 0) {
    const separator = text.length === 0 || text.endsWith("\n") ? "" : newline;
    const content = Buffer.concat([existing.bytes, Buffer.from(separator + block + newline)]);
    return { relative: AGENTS_RELATIVE, content, created: false, previous: { bytes: existing.bytes, mode: existing.mode } };
  }
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);
  if (begin > end) throw new InstallError("conflict", AGENTS_RELATIVE + " managed markers are unbalanced");
  // Accept either line-ending style for the block itself: a stray CRLF in the
  // user's own bytes elsewhere must not invalidate an installed LF block.
  const currentBlock = text.slice(begin, end + MARKER_END.length);
  if (currentBlock !== block && currentBlock !== MANAGED_BLOCK) {
    throw new InstallError("conflict", AGENTS_RELATIVE + " managed block differs from the installed template");
  }
  return undefined;
}

export async function inspectInstallation(root: string, templates: Templates): Promise<Inspection> {
  const changes: Change[] = [];
  let rootInfo;
  try {
    rootInfo = statSync(root);
  } catch {
    throw new InstallError("io", "project root is not readable");
  }
  if (!rootInfo.isDirectory()) throw new InstallError("io", "project root is not a directory");
  const config = await readExisting(root, CONFIG_RELATIVE);
  if (config === undefined) {
    changes.push({ relative: CONFIG_RELATIVE, content: templates.config, created: true });
  } else {
    try {
      parseProjectConfig(JSON.parse(config.bytes.toString("utf8")));
    } catch {
      throw new InstallError("conflict", CONFIG_RELATIVE + " is not a valid project config");
    }
  }
  for (const [relative, template] of [[SKILL_MD_RELATIVE, templates.skillMd], [SKILL_YAML_RELATIVE, templates.skillYaml]] as const) {
    const existing = await readExisting(root, relative);
    if (existing === undefined) {
      changes.push({ relative, content: template, created: true });
    } else if (!existing.bytes.equals(template)) {
      throw new InstallError("conflict", relative + " differs from the owned template");
    }
  }
  const agents = await planAgentsFrom(await readExisting(root, AGENTS_RELATIVE, MAX_AGENTS_BYTES));
  if (agents !== undefined) changes.push(agents);
  return { changes, planned: changes.map(change => change.relative) };
}

async function ensureParents(root: string, relative: string): Promise<void> {
  const segments = relative.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new InstallError("race", relative + " parent is unreadable");
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new InstallError("race", relative + " parent changed under the installation");
  }
  try {
    await mkdir(dirname(join(root, relative)), { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR" || code === "ELOOP") {
      throw new InstallError("race", relative + " parent changed under the installation");
    }
    throw error;
  }
}

async function atomicWrite(path: string, content: Buffer, mode: number): Promise<void> {
  const temp = join(dirname(path), "." + basename(path) + ".turnhelm-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2));
  try {
    await writeFile(temp, content, { mode });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function applyChange(root: string, change: Change): Promise<"written" | "skipped"> {
  let path: string;
  try {
    path = projectPath(root, change.relative);
  } catch {
    throw new InstallError("race", change.relative + " path changed under the installation");
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") info = undefined;
    else throw new InstallError("race", change.relative + " is unreadable");
  }
  if (change.created) {
    if (info !== undefined) throw new InstallError("race", change.relative + " appeared during the installation");
    await ensureParents(root, change.relative);
    await atomicWrite(path, change.content, 0o644);
    return "written";
  }
  if (info === undefined || !info.isFile()) throw new InstallError("race", change.relative + " changed during the installation");
  let current: Buffer | undefined;
  try {
    current = await readProjectFile(root, change.relative, change.relative === AGENTS_RELATIVE ? MAX_AGENTS_BYTES : MAX_FILE_BYTES);
  } catch {
    throw new InstallError("race", change.relative + " changed during the installation");
  }
  if (current === undefined) throw new InstallError("race", change.relative + " disappeared during the installation");
  if (current.equals(change.content)) return "skipped";
  if (!change.previous || !current.equals(change.previous.bytes)) {
    throw new InstallError("race", change.relative + " was modified concurrently");
  }
  await ensureParents(root, change.relative);
  await atomicWrite(path, change.content, change.previous.mode);
  return "written";
}

export async function applyInstallation(root: string, changes: readonly Change[]): Promise<InstallationResult> {
  const planned = changes.map(change => change.relative);
  const applied: { relative: string; created: boolean; path: string; content?: Buffer }[] = [];
  for (const change of changes) {
    try {
      const outcome = await applyChange(root, change);
      if (outcome === "written") {
        applied.push({
          relative: change.relative,
          created: change.created,
          path: projectPath(root, change.relative),
          content: change.created ? change.content : undefined,
        });
      }
    } catch (error) {
      const retained: string[] = [];
      for (const entry of applied) {
        if (!entry.created) {
          retained.push(entry.relative);
          continue;
        }
        try {
          const current = await readFile(entry.path);
          if (entry.content === undefined || !current.equals(entry.content)) {
            retained.push(entry.relative);
            continue;
          }
          try {
            await unlink(entry.path);
          } catch {
            // Unlink refused: the file still exists, so keep it in the report.
            retained.push(entry.relative);
          }
        } catch {
          // Already gone or unreadable: nothing retained for this entry.
        }
      }
      const category = error instanceof InstallError ? error.category : "io";
      return { code: 1, error: category, planned, applied: retained };
    }
  }
  return { code: 0, planned, applied: applied.map(entry => entry.relative) };
}
export async function initProject(root: string, options: { dryRun?: boolean } = {}): Promise<InstallationResult> {
  let templates: Templates;
  try {
    templates = readTemplates();
  } catch (error) {
    if (error instanceof TemplateError) return { code: 1, error: "template", planned: [], applied: [] };
    throw error;
  }
  let inspection: Inspection;
  try {
    inspection = await inspectInstallation(root, templates);
  } catch (error) {
    if (error instanceof InstallError) return { code: 1, error: error.category, planned: [], applied: [] };
    throw error;
  }
  if (options.dryRun) return { code: 0, planned: inspection.planned, applied: [] };
  return applyInstallation(root, inspection.changes);
}
