import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSupportedEffort, readCodexSignals, type CodexSignals } from "./models.js";

export type Backend = "laya" | "jev" | "auto";
export type ProfileMode = "auto" | "explicit";
export type Profile = { description: string; model: string; effort: string };
export type Config = {
  backend: Backend;
  layaUrl: string;
  profiles: Record<string, Profile>;
  fallbackProfile?: string;
  hostedJev: { enabled: boolean };
};
export type RawConfig = {
  backend: Backend;
  layaUrl: string;
  profileMode: ProfileMode;
  profiles?: Record<string, Profile>;
  fallbackProfile?: string;
  hostedJev: { enabled: boolean };
};

const AUTO_ROLE_IDS = ["fast", "balanced", "deep", "frontier"] as const;
const AUTO_ROLES: Record<(typeof AUTO_ROLE_IDS)[number], readonly [string, string, string]> = {
  fast: ["gpt-6-luna", "low", "Small localized edits"],
  balanced: ["gpt-6.1-sol", "medium", "Balanced implementation and routine debugging"],
  deep: ["gpt-6.1-sol", "high", "Complex debugging and review"],
  frontier: ["gpt-6-astra", "xhigh", "Frontier architecture and difficult reasoning"]
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown, name: string, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("invalid " + name);
  }
  return value.trim();
};

function parseProfiles(value: unknown): Record<string, Profile> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error("profiles must be an object");
  const ids = Object.keys(value);
  if (ids.length > 4) throw new Error("profiles must contain 1 to 4 entries");
  const profiles = Object.create(null) as Record<string, Profile>;
  for (const id of ids) {
    if (id === "direct" || !/^[a-z][a-z0-9_]*$/.test(id)) throw new Error("invalid profile ID");
    const raw = value[id];
    if (!isObject(raw)) throw new Error("invalid profile " + id);
    const description = text(raw.description, "description", 80);
    const model = text(raw.model, "model", 200);
    const effort = text(raw.effort, "effort", 32);
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model) || !/^[a-z]+$/.test(effort)) {
      throw new Error("invalid profile model or effort");
    }
    profiles[id] = { description, model, effort };
  }
  return profiles;
}

export function parseRawConfig(value: unknown): RawConfig {
  if (!isObject(value)) throw new Error("config must be an object");
  if (value.backend !== "laya" && value.backend !== "jev" && value.backend !== "auto") {
    throw new Error("backend must be laya, jev, or auto");
  }
  const parsed = new URL(text(value.layaUrl, "layaUrl", 200));
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || parsed.username || parsed.password) {
    throw new Error("layaUrl must use HTTP loopback");
  }
  const profileMode = value.profileMode === undefined ? "explicit" : value.profileMode;
  if (profileMode !== "auto" && profileMode !== "explicit") throw new Error("profileMode must be auto or explicit");
  const profiles = parseProfiles(value.profiles);
  const fallbackProfile = value.fallbackProfile === undefined
    ? undefined
    : text(value.fallbackProfile, "fallbackProfile", 40);
  const hostedJev = value.hostedJev === undefined ? { enabled: false } : (() => {
    if (!isObject(value.hostedJev) || typeof value.hostedJev.enabled !== "boolean") throw new Error("invalid hostedJev");
    return { enabled: value.hostedJev.enabled };
  })();
  return { backend: value.backend, layaUrl: parsed.origin, profileMode, profiles, fallbackProfile, hostedJev };
}

function available(model: string, effort: string, signals: CodexSignals): boolean {
  if (!isSupportedEffort(model, effort)) return false;
  if (signals.defaultModel === model) return true;
  if (!isObject(signals.cached) || !Object.hasOwn(signals.cached, model)) return false;
  const entry = signals.cached[model];
  return !!entry && entry.visible === true && entry.supportedInApi === true && Array.isArray(entry.efforts) && entry.efforts.includes(effort);
}

function materializeExplicit(raw: RawConfig): Config {
  const source = raw.profiles;
  if (!source) throw new Error("profiles must contain 1 to 4 entries");
  const ids = Object.keys(source);
  if (ids.length < 1 || ids.length > 4) throw new Error("profiles must contain 1 to 4 entries");
  const profiles = Object.create(null) as Record<string, Profile>;
  for (const id of ids) profiles[id] = source[id];
  const fallbackProfile = raw.fallbackProfile;
  if (fallbackProfile !== undefined && !Object.hasOwn(profiles, fallbackProfile)) {
    throw new Error("fallbackProfile must name a profile");
  }
  return { backend: raw.backend, layaUrl: raw.layaUrl, profiles, fallbackProfile, hostedJev: raw.hostedJev };
}

function materializeAuto(raw: RawConfig, signals: CodexSignals): Config {
  const overrides = raw.profiles ?? Object.create(null) as Record<string, Profile>;
  for (const id of Object.keys(overrides)) {
    if (!(AUTO_ROLE_IDS as readonly string[]).includes(id)) throw new Error("invalid profile ID for auto mode");
  }
  const profiles = Object.create(null) as Record<string, Profile>;
  for (const id of AUTO_ROLE_IDS) {
    const override = Object.hasOwn(overrides, id) ? overrides[id] : undefined;
    if (override) {
      if (!isSupportedEffort(override.model, override.effort)) {
        throw new Error("profile " + id + " uses an unsupported effort");
      }
      if (!available(override.model, override.effort, signals)) {
        throw new Error("profile " + id + " is not available in Codex capability signals");
      }
      profiles[id] = override;
      continue;
    }
    const [model, effort, description] = AUTO_ROLES[id];
    if (available(model, effort, signals)) profiles[id] = { description, model, effort };
  }
  if (Object.keys(profiles).length === 0) throw new Error("no available profiles for auto mode");
  let fallbackProfile = raw.fallbackProfile;
  if (fallbackProfile === undefined) {
    if (Object.hasOwn(profiles, "balanced")) fallbackProfile = "balanced";
    else if (Object.hasOwn(profiles, "fast")) fallbackProfile = "fast";
  }
  if (fallbackProfile !== undefined && !Object.hasOwn(profiles, fallbackProfile)) {
    throw new Error("fallbackProfile must name an available profile");
  }
  return { backend: raw.backend, layaUrl: raw.layaUrl, profiles, fallbackProfile, hostedJev: raw.hostedJev };
}

export function materializeConfig(raw: RawConfig, signals: CodexSignals): Config {
  return raw.profileMode === "auto" ? materializeAuto(raw, signals) : materializeExplicit(raw);
}

export function parseConfig(value: unknown, signals: CodexSignals = { cached: {} }): Config {
  return materializeConfig(parseRawConfig(value), signals);
}

export function loadConfig(
  path = process.env.TURNHELM_CONFIG ?? join(homedir(), ".config", "turnhelm", "config.json")
): Config {
  return materializeConfig(parseRawConfig(JSON.parse(readFileSync(path, "utf8"))), readCodexSignals());
}
