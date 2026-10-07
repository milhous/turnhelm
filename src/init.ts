import { statSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { TemplateError, readTemplates, type Templates } from "./assets.js";
import { parseProjectConfig } from "./config.js";
import { projectPath, readProjectFile } from "./project.js";

export type Change = Readonly<{
  path: string;
  before?: Buffer;
  beforeIdentity?: Readonly<{ dev: number; ino: number }>;
  after: Buffer;
  mode: number;
}>;

export type InstallationResult = Readonly<{
  code: 0 | 1;
  applied: readonly string[];
  error?: "conflict" | "race" | "write";
}>;

type FaultCategory = "conflict" | "race" | "write";

class InstallError extends Error {
  constructor(readonly category: FaultCategory, message: string) {
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

const maxFor = (path: string): number => (path === AGENTS_RELATIVE ? MAX_AGENTS_BYTES : MAX_FILE_BYTES);

// Inspect-time observations kept out of the frozen Change shape: parent
// directory identities per inspection, and the identity of files this
// invocation created. In-memory only; never persisted.
const PARENT_IDENTITIES = new WeakMap<object, ReadonlyMap<string, Readonly<{ dev: number; ino: number }> | undefined>>();
const CREATED_IDENTITIES = new WeakMap<object, Readonly<{ dev: number; ino: number }>>();

type Identity = Readonly<{ dev: number; ino: number }>;
type Existing = { bytes: Buffer; mode: number; identity: Identity };

function toIdentity(info: { dev: number; ino: number }): Identity {
  return { dev: info.dev, ino: info.ino };
}

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
  return { bytes, mode: info.mode & 0o777, identity: toIdentity(info) };
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

function planAgentsFrom(block: string, existing: Existing | undefined): Change | undefined {
  if (existing === undefined) {
    return { path: AGENTS_RELATIVE, after: Buffer.from(block + "\n"), mode: 0o644 };
  }
  const text = existing.bytes.toString("utf8");
  const beginCount = countOccurrences(text, MARKER_BEGIN);
  const endCount = countOccurrences(text, MARKER_END);
  if (!(beginCount === 0 && endCount === 0) && (beginCount !== 1 || endCount !== 1)) {
    throw new InstallError("conflict", AGENTS_RELATIVE + " managed markers are duplicated or unbalanced");
  }
  const crlf = text.includes("\r\n");
  const newline = crlf ? "\r\n" : "\n";
  const styledBlock = crlf ? block.replaceAll("\n", "\r\n") : block;
  if (beginCount === 0) {
    const separator = text.length === 0 || text.endsWith("\n") ? "" : newline;
    const after = Buffer.concat([existing.bytes, Buffer.from(separator + styledBlock + newline)]);
    return { path: AGENTS_RELATIVE, before: existing.bytes, beforeIdentity: existing.identity, after, mode: existing.mode };
  }
  const begin = text.indexOf(MARKER_BEGIN);
  const end = text.indexOf(MARKER_END);
  if (begin > end) throw new InstallError("conflict", AGENTS_RELATIVE + " managed markers are unbalanced");
  // Accept either line-ending style for the block itself: a stray CRLF in the
  // user's own bytes elsewhere must not invalidate an installed LF block.
  const currentBlock = text.slice(begin, end + MARKER_END.length);
  if (currentBlock !== styledBlock && currentBlock !== block) {
    throw new InstallError("conflict", AGENTS_RELATIVE + " managed block differs from the installed template");
  }
  return undefined;
}

async function assertRoot(root: string): Promise<void> {
  let info;
  try {
    info = statSync(root);
  } catch {
    throw new InstallError("write", "project root is not readable");
  }
  if (!info.isDirectory()) throw new InstallError("write", "project root is not a directory");
}

async function recordParentIdentities(root: string, changes: readonly Change[]): Promise<void> {
  const identities = new Map<string, Identity | undefined>();
  for (const change of changes) {
    let current = root;
    for (const segment of change.path.split("/").slice(0, -1)) {
      current = join(current, segment);
      if (identities.has(current)) continue;
      try {
        const info = await lstat(current);
        identities.set(current, info.isDirectory() && !info.isSymbolicLink() ? toIdentity(info) : undefined);
      } catch {
        identities.set(current, undefined);
      }
    }
  }
  for (const change of changes) PARENT_IDENTITIES.set(change, identities);
}

export async function inspectInstallation(root: string, templates: Templates): Promise<readonly Change[]> {
  await assertRoot(root);
  const changes: Change[] = [];
  const config = await readExisting(root, CONFIG_RELATIVE);
  if (config === undefined) {
    changes.push({ path: CONFIG_RELATIVE, after: templates.config, mode: 0o644 });
  } else {
    try {
      parseProjectConfig(JSON.parse(config.bytes.toString("utf8")));
    } catch {
      throw new InstallError("conflict", CONFIG_RELATIVE + " is not a valid project config");
    }
  }
  for (const [path, template] of [[SKILL_MD_RELATIVE, templates.skill], [SKILL_YAML_RELATIVE, templates.metadata]] as const) {
    const existing = await readExisting(root, path);
    if (existing === undefined) {
      changes.push({ path, after: template, mode: 0o644 });
    } else if (!existing.bytes.equals(template)) {
      throw new InstallError("conflict", path + " differs from the owned template");
    }
  }
  const agents = planAgentsFrom(templates.agentsBlock, await readExisting(root, AGENTS_RELATIVE, MAX_AGENTS_BYTES));
  if (agents !== undefined) changes.push(agents);
  await recordParentIdentities(root, changes);
  return changes;
}

async function verifyParents(root: string, change: Change): Promise<void> {
  const recorded = PARENT_IDENTITIES.get(change);
  let current = root;
  for (const segment of change.path.split("/").slice(0, -1)) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new InstallError("race", change.path + " parent is unreadable");
      }
      if (recorded !== undefined && recorded.has(current) && recorded.get(current) !== undefined) {
        throw new InstallError("race", change.path + " parent disappeared during the installation");
      }
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new InstallError("race", change.path + " parent changed under the installation");
    }
    const expected = recorded?.get(current);
    if (expected !== undefined && (info.dev !== expected.dev || info.ino !== expected.ino)) {
      throw new InstallError("race", change.path + " parent identity changed under the installation");
    }
  }
}

async function verifyChange(root: string, change: Change): Promise<void> {
  let path: string;
  try {
    path = projectPath(root, change.path);
  } catch {
    throw new InstallError("race", change.path + " path changed under the installation");
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") info = undefined;
    else throw new InstallError("race", change.path + " is unreadable");
  }
  if (change.before === undefined) {
    if (info !== undefined) throw new InstallError("race", change.path + " appeared during the installation");
  } else {
    if (info === undefined) throw new InstallError("race", change.path + " disappeared during the installation");
    if (!info.isFile()) throw new InstallError("race", change.path + " changed during the installation");
    if (change.beforeIdentity !== undefined && (info.dev !== change.beforeIdentity.dev || info.ino !== change.beforeIdentity.ino)) {
      throw new InstallError("race", change.path + " identity changed during the installation");
    }
    if ((info.mode & 0o777) !== change.mode) {
      throw new InstallError("race", change.path + " mode changed during the installation");
    }
    let current: Buffer | undefined;
    try {
      current = await readProjectFile(root, change.path, maxFor(change.path));
    } catch {
      throw new InstallError("race", change.path + " changed during the installation");
    }
    if (current === undefined || !current.equals(change.before)) {
      throw new InstallError("race", change.path + " was modified concurrently");
    }
  }
  await verifyParents(root, change);
}

async function ensureParents(root: string, relative: string): Promise<void> {
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

async function applyChange(root: string, change: Change): Promise<void> {
  await verifyChange(root, change);
  const path = projectPath(root, change.path);
  await ensureParents(root, change.path);
  const temp = join(dirname(path), "." + basename(path) + ".turnhelm-tmp-" + process.pid + "-" + Math.random().toString(36).slice(2));
  try {
    await writeFile(temp, change.after, { mode: change.mode });
    // writeFile filters the mode through the process umask; chmod restores
    // the exact existing permission bits.
    await chmod(temp, change.mode);
    // Revalidate identity/content/mode and parents immediately before the
    // rename so an ordinary concurrent edit between the temp write and the
    // rename is detected and refused.
    await verifyChange(root, change);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function applyInstallation(root: string, changes: readonly Change[]): Promise<InstallationResult> {
  // Preflight every change before any write: a race detected on the last
  // planned target must not be preceded by partial installation.
  try {
    for (const change of changes) await verifyChange(root, change);
  } catch (error) {
    if (error instanceof InstallError) return { code: 1, applied: [], error: error.category };
    return { code: 1, applied: [], error: "write" };
  }
  const applied: { change: Change; path: string }[] = [];
  for (const change of changes) {
    let path: string;
    try {
      path = projectPath(root, change.path);
      await applyChange(root, change);
      if (change.before === undefined) {
        CREATED_IDENTITIES.set(change, toIdentity(await lstat(path)));
      }
      applied.push({ change, path });
    } catch (error) {
      const category: FaultCategory = error instanceof InstallError ? error.category : "write";
      const retained: string[] = [];
      for (const entry of applied) {
        if (entry.change.before !== undefined) {
          // Replaced a user file: never rolled back, always still applied.
          retained.push(entry.change.path);
          continue;
        }
        const expected = CREATED_IDENTITIES.get(entry.change);
        let info;
        try {
          info = await lstat(entry.path);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") retained.push(entry.change.path);
          continue;
        }
        try {
          const current = await readFile(entry.path);
          const unchanged = expected !== undefined
            && info.dev === expected.dev && info.ino === expected.ino
            && current.equals(entry.change.after);
          if (unchanged) {
            try {
              await unlink(entry.path);
            } catch {
              retained.push(entry.change.path);
            }
          } else {
            retained.push(entry.change.path);
          }
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") retained.push(entry.change.path);
        }
      }
      return { code: 1, applied: retained, error: category };
    }
  }
  return { code: 0, applied: changes.map(change => change.path) };
}

export async function initProject(
  root: string,
  options: { dryRun: boolean },
): Promise<InstallationResult & Readonly<{ planned: readonly string[] }>> {
  let templates: Templates;
  try {
    templates = await readTemplates();
  } catch (error) {
    if (error instanceof TemplateError) return { code: 1, applied: [], error: "write", planned: [] };
    throw error;
  }
  let changes: readonly Change[];
  try {
    changes = await inspectInstallation(root, templates);
  } catch (error) {
    if (error instanceof InstallError) return { code: 1, applied: [], error: error.category, planned: [] };
    throw error;
  }
  const planned = changes.map(change => change.path);
  if (options.dryRun) return { code: 0, applied: [], planned };
  return { ...await applyInstallation(root, changes), planned };
}
