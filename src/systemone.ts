import type { Config } from "./config.js";
import { localRoutingReason } from "./task.js";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function buildSystemOneRequest(config: Config, prompt: string, backend: "laya" | "jev"): Record<string, unknown> {
  const criteria: Record<string, string> = {
    direct: "No coding, debugging, review, or file-change work"
  };
  for (const [id, profile] of Object.entries(config.profiles)) criteria[id] = profile.description;
  return {
    state: prompt,
    model: backend === "jev" ? "jev-latest" : "typed-decisions",
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

const responseByteLimit = 64 * 1024;

async function readDecision(response: Response): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!response.body) throw new Error("missing body");
    reader = response.body.getReader();
    if (Number(response.headers.get("content-length")) > responseByteLimit) throw new Error("response too large");
    const bytes = new Uint8Array(responseByteLimit);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > responseByteLimit - size) throw new Error("response too large");
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    try { await reader?.cancel(); } catch { /* Cleanup must not replace the controlled failure. */ }
    throw new Error("classifier unavailable");
  } finally {
    try { reader?.releaseLock(); } catch { /* Never expose stream cleanup errors. */ }
  }
}

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
    redirect: "error",
    signal: AbortSignal.timeout(4000)
  });
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Keep the status-only failure if cleanup fails. */ }
    throw new Error("classifier HTTP " + response.status);
  }
  const data = await readDecision(response);
  if (!object(data) || !object(data.answers) || !object(data.answers.route)) {
    throw new Error("classifier returned no route");
  }
  const answer = data.answers.route;
  if (answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("classifier returned an invalid choice");
  }
  if (answer.choice !== "direct" && !Object.hasOwn(config.profiles, answer.choice)) throw new Error("classifier unavailable");
  return answer.choice;
}

export async function chooseProfile(config: Config, prompt: string): Promise<string> {
  if (localRoutingReason(prompt)) throw new Error("task is not eligible for classification");
  if (config.backend === "laya") return callDecision(config, prompt, "laya");
  if (config.backend === "jev") return callDecision(config, prompt, "jev");
  try { return await callDecision(config, prompt, "laya"); }
  catch (error) {
    if (!hostedJevAllowed(config)) throw error;
    try { return await callDecision(config, prompt, "jev"); } catch { throw new Error("classifier unavailable"); }
  }
}
