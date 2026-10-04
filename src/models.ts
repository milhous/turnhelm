import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type ModelCapability = { efforts: readonly string[] };

export const OFFICIAL_MODEL_CAPABILITIES: Record<string, ModelCapability> = Object.freeze({
  "gpt-6-astra": Object.freeze({ efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]) }),
  "gpt-6.1-sol": Object.freeze({ efforts: Object.freeze(["low", "medium", "high", "xhigh", "max"]) }),
  "gpt-6-luna": Object.freeze({ efforts: Object.freeze(["none", "low", "medium", "high", "xhigh", "max"]) })
});

export type CodexSignals = {
  defaultModel?: string;
  cached: Record<string, { visible: boolean; supportedInApi: boolean; efforts: string[] }>;
};

const MAX_METADATA_BYTES = 1024 * 1024;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isSupportedEffort(model: string, effort: string): boolean {
  return typeof model === "string" && typeof effort === "string" &&
    Object.hasOwn(OFFICIAL_MODEL_CAPABILITIES, model) &&
    OFFICIAL_MODEL_CAPABILITIES[model].efforts.includes(effort);
}

function readBounded(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    const size = statSync(path).size;
    if (!Number.isSafeInteger(size) || size > MAX_METADATA_BYTES) return undefined;
    descriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(MAX_METADATA_BYTES + 1);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytes > MAX_METADATA_BYTES) return undefined;
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best-effort metadata read */ }
    }
  }
}

function readDefaultModel(home: string): string | undefined {
  const text = readBounded(join(home, "config.toml"));
  if (text === undefined) return undefined;
  const match = /^[ \t]*model[ \t]*=[ \t]*"([^"\r\n]*)"[ \t]*(?:#.*)?$/m.exec(text);
  const model = match?.[1];
  return model && Object.hasOwn(OFFICIAL_MODEL_CAPABILITIES, model) ? model : undefined;
}

function readCachedModels(home: string): CodexSignals["cached"] {
  const text = readBounded(join(home, "models_cache.json"));
  if (text === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  if (!isObject(parsed) || !Array.isArray(parsed.models)) return {};
  const cached: CodexSignals["cached"] = {};
  for (const entry of parsed.models) {
    if (!isObject(entry) || typeof entry.slug !== "string" ||
      (entry.visibility !== "visible" && entry.visibility !== "hidden") ||
      typeof entry.supported_in_api !== "boolean" || !Array.isArray(entry.supported_reasoning_levels) ||
      !Object.hasOwn(OFFICIAL_MODEL_CAPABILITIES, entry.slug)) continue;
    if (!entry.supported_in_api) continue;
    const efforts = entry.supported_reasoning_levels
      .filter(isObject)
      .map(level => level.effort)
      .filter((effort): effort is string => typeof effort === "string");
    const official = OFFICIAL_MODEL_CAPABILITIES[entry.slug].efforts;
    const normalized = official.filter(effort => efforts.includes(effort));
    cached[entry.slug] = {
      visible: entry.visibility === "visible",
      supportedInApi: true,
      efforts: normalized
    };
  }
  return cached;
}

export function readCodexSignals(env: NodeJS.ProcessEnv = process.env): CodexSignals {
  const home = env.CODEX_HOME;
  if (typeof home !== "string" || !home) return { cached: {} };
  const cached = readCachedModels(home);
  const defaultModel = readDefaultModel(home);
  return defaultModel === undefined ? { cached } : { defaultModel, cached };
}
