import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type Templates = Readonly<{ config: Buffer; skillMd: Buffer; skillYaml: Buffer }>;

export class TemplateError extends Error {}

const MAX_TEMPLATE_BYTES = 65536;
const READ_CHUNK_BYTES = 4096;

function readTemplate(url: URL, what: string): Buffer {
  const path = fileURLToPath(url);
  const chunks: Buffer[] = [];
  let total = 0;
  let descriptor: number | undefined;
  try {
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new TemplateError(what + " template is missing");
      throw error;
    }
    if (!fstatSync(descriptor).isFile()) throw new TemplateError(what + " template is not a regular file");
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    while (total <= MAX_TEMPLATE_BYTES) {
      const read = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_TEMPLATE_BYTES + 1 - total), null);
      if (read === 0) break;
      total += read;
      chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (total > MAX_TEMPLATE_BYTES) throw new TemplateError(what + " template exceeds " + MAX_TEMPLATE_BYTES + " bytes");
  return Buffer.concat(chunks);
}

export function readTemplates(): Templates {
  return {
    config: readTemplate(new URL("../../assets/config.json", import.meta.url), "config"),
    skillMd: readTemplate(new URL("../../.agents/skills/turnhelm-routing/SKILL.md", import.meta.url), "SKILL.md"),
    skillYaml: readTemplate(new URL("../../.agents/skills/turnhelm-routing/agents/openai.yaml", import.meta.url), "agents/openai.yaml"),
  };
}
