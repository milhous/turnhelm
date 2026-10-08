import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Templates = Readonly<{ config: Buffer; skill: Buffer; metadata: Buffer; agentsBlock: string }>;

export class TemplateError extends Error {}

const MAX_TEMPLATE_BYTES = 65536;
const READ_CHUNK_BYTES = 4096;

export const MANAGED_BLOCK = [
  "<!-- turnhelm:begin v1 -->",
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
  "<!-- turnhelm:end -->",
].join("\n");

function readTemplate(url: URL, what: string): Buffer {
  const path = fileURLToPath(url);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TemplateError(what + " template is missing");
      throw error;
    }
    try {
      if (!fstatSync(descriptor).isFile()) throw new TemplateError(what + " template is not a regular file");
      const chunk = Buffer.alloc(READ_CHUNK_BYTES);
      while (total <= MAX_TEMPLATE_BYTES) {
        const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_TEMPLATE_BYTES + 1 - total), null);
        if (read === 0) break;
        total += read;
        chunks.push(Buffer.from(chunk.subarray(0, read)));
      }
    } finally {
      closeSync(descriptor);
    }
    if (total > MAX_TEMPLATE_BYTES) throw new TemplateError(what + " template exceeds " + MAX_TEMPLATE_BYTES + " bytes");
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof TemplateError) throw error;
    throw new TemplateError(what + " template is unreadable: " + (error as Error).message);
  }
}

export async function readTemplates(): Promise<Templates> {
  return {
    config: readTemplate(new URL("../../assets/config.json", import.meta.url), "config"),
    skill: readTemplate(new URL("../../.agents/skills/turnhelm-routing/SKILL.md", import.meta.url), "SKILL.md"),
    metadata: readTemplate(new URL("../../.agents/skills/turnhelm-routing/agents/openai.yaml", import.meta.url), "agents/openai.yaml"),
    agentsBlock: MANAGED_BLOCK,
  };
}
