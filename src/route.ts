import type { Config, Profile } from "./config.js";
import { chooseProfile } from "./systemone.js";
import { localRoutingReason } from "./task.js";

export type ClassifierDecision =
  | { kind: "direct" }
  | { kind: "profile"; profileId: string; profile: Profile };

export type RouteDecision = ClassifierDecision & {
  source: "classifier" | "continuation" | "fallback";
};

const profile = (id: string, config: Config, source: RouteDecision["source"]): RouteDecision => ({
  kind: "profile",
  source,
  profileId: id,
  profile: config.profiles[id]
});

export async function classifyTask(prompt: string, config: Config): Promise<ClassifierDecision> {
  const choice = await chooseProfile(config, prompt);
  if (choice === "direct") return { kind: "direct" };
  if (!Object.hasOwn(config.profiles, choice)) throw new Error("classifier returned an unknown profile");
  return profile(choice, config, "classifier");
}

export async function resolvePhaseARoute(prompt: string, config: Config): Promise<RouteDecision> {
  const reason = localRoutingReason(prompt);
  if (reason) {
    if (!config.fallbackProfile) throw new Error("fallbackProfile is required for this Phase A input");
    return profile(config.fallbackProfile, config, reason);
  }
  try {
    const decision = await classifyTask(prompt, config);
    return { ...decision, source: "classifier" } as RouteDecision;
  } catch {
    if (!config.fallbackProfile) throw new Error("routing unavailable and no fallbackProfile is configured");
    return profile(config.fallbackProfile, config, "fallback");
  }
}
