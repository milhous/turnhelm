import type { Config } from "./config.js";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function buildSystemOneRequest(config: Config, prompt: string, backend?: "laya" | "jev"): Record<string, unknown> {
  const selected = backend ?? (config.backend === "jev" ? "jev" : "laya");
  const criteria: Record<string, string> = {
    direct: "No coding, debugging, review, or file-change work"
  };
  for (const [id, profile] of Object.entries(config.profiles)) criteria[id] = profile.description;
  return {
    state: prompt,
    model: selected === "jev" ? "jev-latest" : "typed-decisions",
    questions: {
      route: {
        type: "choice",
        instructions: "Choose the best route for this coding assistant request.",
        criteria
      }
    }
  };
}

const hostedJevAllowed = (config: Config) => config.hostedJev.enabled && process.env.TURNHELM_ALLOW_HOSTED_JEV === "1";

async function callDecision(config: Config, prompt: string, backend: "laya" | "jev"): Promise<string> {
  if (backend === "jev" && !hostedJevAllowed(config)) throw new Error("hosted Jev is not enabled");
  const key = backend === "jev" ? process.env.TYPESAFE_API_KEY : process.env.LAYA_API_KEY;
  if (backend === "jev" && !key) throw new Error("TYPESAFE_API_KEY is required");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;
  const base = backend === "jev" ? "https://api.typesafe.ai" : config.layaUrl;
  const response = await fetch(new URL("/v1/systemone", base), {
    method: "POST",
    headers,
    body: JSON.stringify(buildSystemOneRequest(config, prompt, backend)),
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) throw new Error("classifier HTTP " + response.status);
  const data: unknown = await response.json();
  if (!object(data) || !object(data.answers) || !object(data.answers.route)) {
    throw new Error("classifier returned no route");
  }
  const answer = data.answers.route;
  if (answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("classifier returned an invalid choice");
  }
  if (answer.choice !== "direct" && !(answer.choice in config.profiles)) throw new Error("classifier unavailable");
  return answer.choice;
}

export async function chooseProfile(config: Config, prompt: string): Promise<string> {
  if (config.backend === "laya") return callDecision(config, prompt, "laya");
  if (config.backend === "jev") return callDecision(config, prompt, "jev");
  try { return await callDecision(config, prompt, "laya"); }
  catch (error) {
    if (!hostedJevAllowed(config)) throw error;
    try { return await callDecision(config, prompt, "jev"); } catch { throw new Error("classifier unavailable"); }
  }
}
