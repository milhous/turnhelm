import type { Config, Profile } from "./config.js";
import { chooseProfile } from "./systemone.js";

export type ClassifierDecision =
  | { kind: "direct" }
  | { kind: "profile"; profileId: string; profile: Profile };

export type RouteDecision = ClassifierDecision & {
  source: "classifier" | "continuation" | "fallback";
};

const continuation = /^(继续|接着做|按刚才的方案继续|continue|go on|proceed)[.!。！\s]*$/i;

const profile = (id: string, config: Config, source: RouteDecision["source"]): RouteDecision => ({
  kind: "profile",
  source,
  profileId: id,
  profile: config.profiles[id]
});

export async function classifyTask(prompt: string, config: Config): Promise<ClassifierDecision> {
  if (!prompt.trim()) throw new Error("task must not be empty");
  const choice = await chooseProfile(config, prompt);
  if (choice === "direct") return { kind: "direct" };
  if (!Object.hasOwn(config.profiles, choice)) throw new Error("classifier returned an unknown profile");
  return profile(choice, config, "classifier");
}

export async function resolvePhaseARoute(prompt: string, config: Config): Promise<RouteDecision> {
  if (!prompt.trim()) throw new Error("task must not be empty");
  if (continuation.test(prompt.trim()) || prompt.length > 2000) {
    if (!config.fallbackProfile) throw new Error("fallbackProfile is required for this Phase A input");
    return profile(config.fallbackProfile, config, prompt.length > 2000 ? "fallback" : "continuation");
  }
  try {
    const decision = await classifyTask(prompt, config);
    return { ...decision, source: "classifier" } as RouteDecision;
  } catch {
    if (!config.fallbackProfile) throw new Error("routing unavailable and no fallbackProfile is configured");
    return profile(config.fallbackProfile, config, "fallback");
  }
}
