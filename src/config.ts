import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Backend = "laya" | "jev" | "auto";
export type Profile = { description: string; model: string; effort: string };
export type Config = {
  backend: Backend;
  layaUrl: string;
  profiles: Record<string, Profile>;
  fallbackProfile?: string;
  hostedJev: { enabled: boolean };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("invalid " + name);
  }
  return value.trim();
};

export function parseConfig(value: unknown): Config {
  if (!isObject(value)) throw new Error("config must be an object");
  if (value.backend !== "laya" && value.backend !== "jev" && value.backend !== "auto") throw new Error("backend must be laya, jev, or auto");
  const parsed = new URL(text(value.layaUrl, "layaUrl", 200));
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || parsed.username || parsed.password) {
    throw new Error("layaUrl must use HTTP loopback");
  }
  if (!isObject(value.profiles)) throw new Error("profiles must be an object");
  const ids = Object.keys(value.profiles);
  if (ids.length < 1 || ids.length > 4) throw new Error("profiles must contain 1 to 4 entries");
  const profiles = Object.create(null) as Record<string, Profile>;
  for (const id of ids) {
    if (id === "direct" || !/^[a-z][a-z0-9_]*$/.test(id)) throw new Error("invalid profile ID");
    const raw = value.profiles[id];
    if (!isObject(raw)) throw new Error("invalid profile " + id);
    const description = text(raw.description, "description", 80);
    const model = text(raw.model, "model", 200);
    const effort = text(raw.effort, "effort", 32);
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model) || !/^[a-z]+$/.test(effort)) {
      throw new Error("invalid profile model or effort");
    }
    profiles[id] = { description, model, effort };
  }
  const fallbackProfile = value.fallbackProfile === undefined
    ? undefined
    : text(value.fallbackProfile, "fallbackProfile", 40);
  if (fallbackProfile && !Object.hasOwn(profiles, fallbackProfile)) {
    throw new Error("fallbackProfile must name a profile");
  }
  const hostedJev = value.hostedJev === undefined ? { enabled: false } : (() => {
    if (!isObject(value.hostedJev) || typeof value.hostedJev.enabled !== "boolean") throw new Error("invalid hostedJev");
    return { enabled: value.hostedJev.enabled };
  })();
  return { backend: value.backend, layaUrl: parsed.origin, profiles, fallbackProfile, hostedJev };
}

export function loadConfig(
  path = process.env.TURNHELM_CONFIG ?? join(homedir(), ".config", "turnhelm", "config.json")
): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
