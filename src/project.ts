import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const READ_CHUNK_BYTES = 4096;

export function resolveProject(project?: string, cwd?: string): string {
  const root = realpathSync(resolve(cwd ?? process.cwd(), project ?? "."));
  if (!statSync(root).isDirectory()) throw new Error("project root must be a directory");
  return root;
}

export function projectPath(root: string, relative: string): string {
  if (isAbsolute(relative)) throw new Error("project paths must be relative");
  const segments = relative.split("/");
  if (segments.includes("..")) throw new Error("project paths must not contain ..");
  const joined = join(root, relative);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let info;
    try {
      info = lstatSync(current);
    } catch {
      return joined;
    }
    if (info.isSymbolicLink()) throw new Error("project paths must not traverse symbolic links");
    if (current !== joined && !info.isDirectory()) throw new Error("project path parent is not a directory");
  }
  return joined;
}

export async function readProjectFile(root: string, relative: string, max: number): Promise<Buffer | undefined> {
  const path = projectPath(root, relative);
  const chunks: Buffer[] = [];
  let total = 0;
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (!fstatSync(descriptor).isFile()) throw new Error("project file is not a regular file");
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    while (total <= max) {
      const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, max + 1 - total), null);
      if (read === 0) break;
      total += read;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (total > max) throw new Error("project file exceeds " + max + " bytes");
  return Buffer.concat(chunks);
}
