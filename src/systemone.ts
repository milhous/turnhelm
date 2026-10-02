import type { Config } from "./config.js";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function buildSystemOneRequest(config: Config, prompt: string): Record<string, unknown> {
  const criteria: Record<string, string> = {
    direct: "No coding, debugging, review, or file-change work"
  };
  for (const [id, profile] of Object.entries(config.profiles)) criteria[id] = profile.description;
  return {
    state: prompt,
    model: config.backend === "jev" ? "jev-latest" : "typed-decisions",
    questions: {
      route: {
        type: "choice",
        instructions: "Choose the best route for this coding assistant request.",
        criteria
      }
    }
  };
}

export async function chooseProfile(config: Config, prompt: string): Promise<string> {
  const body = buildSystemOneRequest(config, prompt);
  const key = config.backend === "jev" ? process.env.TYPESAFE_API_KEY : process.env.LAYA_API_KEY;
  if (config.backend === "jev" && !key) throw new Error("TYPESAFE_API_KEY is required");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = "Bearer " + key;
  const base = config.backend === "jev" ? "https://api.typesafe.ai" : config.layaUrl;
  const response = await fetch(new URL("/v1/systemone", base), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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
  return answer.choice;
}
