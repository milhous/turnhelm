import { readProjectFile } from "./project.js";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type ProfileId = "fast" | "balanced" | "deep" | "frontier" | "frontier_xhigh" | "frontier_max";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type TaskProfile = Readonly<{ model: string; effort: Effort }>;
export type ProjectConfig = Readonly<{
  version: 1;
  routingTimeoutMs: number;
  backends: Readonly<{ laya: Readonly<{ enabled: boolean; url: string }>; jev: Readonly<{ enabled: boolean }> }>;
  profiles: Readonly<Record<ProfileId, TaskProfile>>;
}>;

export const PROFILE_IDS: readonly ProfileId[] = ["fast", "balanced", "deep", "frontier", "frontier_xhigh", "frontier_max"];
const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
const CONFIG_DECODER = new TextDecoder("utf-8", { fatal: true });

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

const ownKeys = (value: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(what + " must not contain unknown field " + JSON.stringify(key));
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) throw new Error(what + " must contain own field " + JSON.stringify(key));
  }
};

const layaOrigin = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("laya url must be a string");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("laya url must be an absolute URL");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const pathless = parsed.pathname === "" || parsed.pathname === "/";
  if (parsed.protocol !== "http:" || !["127.0.0.1", "::1"].includes(host) || parsed.username || parsed.password
    || !pathless || parsed.search || parsed.hash) {
    throw new Error("laya url must be an HTTP loopback origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
};

const parseLayaBackend = (value: unknown): ProjectConfig["backends"]["laya"] => {
  if (!isObject(value)) throw new Error("laya backend must be an object");
  ownKeys(value, ["enabled", "url"], "laya backend");
  if (typeof value.enabled !== "boolean") throw new Error("laya enabled must be a boolean");
  return deepFreeze({ enabled: value.enabled, url: layaOrigin(value.url) });
};

const parseJevBackend = (value: unknown): ProjectConfig["backends"]["jev"] => {
  if (!isObject(value)) throw new Error("jev backend must be an object");
  ownKeys(value, ["enabled"], "jev backend");
  if (typeof value.enabled !== "boolean") throw new Error("jev enabled must be a boolean");
  return deepFreeze({ enabled: value.enabled });
};

const parseProjectProfiles = (value: unknown): Readonly<Record<ProfileId, TaskProfile>> => {
  if (!isObject(value)) throw new Error("profiles must be an object");
  const ids = Object.keys(value);
  if (ids.length !== PROFILE_IDS.length || !PROFILE_IDS.every(id => Object.hasOwn(value, id))) {
    throw new Error("profiles must define exactly " + PROFILE_IDS.join(", "));
  }
  const profiles = Object.create(null) as Record<ProfileId, TaskProfile>;
  for (const id of PROFILE_IDS) {
    const raw = value[id];
    if (!isObject(raw)) throw new Error("profile " + id + " must be an object");
    ownKeys(raw, ["model", "effort"], "profile " + id);
    if (typeof raw.model !== "string" || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(raw.model)) {
      throw new Error("profile " + id + " has an invalid model");
    }
    if (typeof raw.effort !== "string" || !(EFFORTS as readonly string[]).includes(raw.effort)) {
      throw new Error("profile " + id + " has an invalid effort");
    }
    profiles[id] = deepFreeze({ model: raw.model, effort: raw.effort as Effort });
  }
  return deepFreeze(profiles);
};

export function parseProjectConfig(value: unknown): ProjectConfig {
  if (!isObject(value)) throw new Error("config must be an object");
  ownKeys(value, ["version", "routingTimeoutMs", "backends", "profiles"], "config");
  if (value.version !== 1) throw new Error("config version must be 1");
  const routingTimeoutMs = value.routingTimeoutMs;
  if (typeof routingTimeoutMs !== "number" || !Number.isInteger(routingTimeoutMs)
    || routingTimeoutMs < 100 || routingTimeoutMs > 30000) {
    throw new Error("routingTimeoutMs must be an integer from 100 to 30000");
  }
  if (!isObject(value.backends)) throw new Error("backends must be an object");
  ownKeys(value.backends, ["laya", "jev"], "backends");
  const laya = parseLayaBackend(value.backends.laya);
  const jev = parseJevBackend(value.backends.jev);
  const profiles = parseProjectProfiles(value.profiles);
  return deepFreeze({ version: 1, routingTimeoutMs, backends: { laya, jev }, profiles });
}

export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  const file = await readProjectFile(root, ".turnhelm/config.json", 65536);
  if (file === undefined) throw new Error(".turnhelm/config.json is missing");
  return parseProjectConfig(JSON.parse(CONFIG_DECODER.decode(file)));
}
