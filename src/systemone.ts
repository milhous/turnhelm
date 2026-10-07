import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as SecureAgent, request as httpsRequest } from "node:https";
import { PROFILE_IDS, type Config, type ProfileId, type ProjectConfig } from "./config.js";
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

export type TaskBackend = "laya" | "jev";

export type RequestSpec = Readonly<{
  backend: TaskBackend;
  url: URL;
  body: string;
  headers: Readonly<Record<string, string>>;
  signal: AbortSignal;
}>;

// Bounded and decoded directly; never a Fetch Response or a generic client.
export type ChoiceRequest = (spec: RequestSpec) => Promise<unknown>;

export type TaskAttempt = Readonly<{
  backend: TaskBackend;
  outcome: "success" | "failed" | "timeout" | "cancelled";
  durationMs: number;
}>;

const RESPONSE_LIMIT = 8192;
const RESPONSE_DECODER = new TextDecoder("utf-8", { fatal: true });

export function directChoiceRequest(spec: RequestSpec): Promise<unknown> {
  const secure = spec.url.protocol === "https:";
  // proxyEnv:{} keeps the built-in environment proxy off where the runtime supports
  // it; runtimes without the option ignore it, so the request stays direct either way.
  const agent: Agent = secure
    ? new SecureAgent({ keepAlive: false, proxyEnv: {} })
    : new Agent({ keepAlive: false, proxyEnv: {} });
  return new Promise((resolve, reject) => {
    let ownedRequest: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const onAbort = (): void => fail("classifier request was cancelled");
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      spec.signal.removeEventListener("abort", onAbort);
      ownedRequest?.destroy();
      response?.destroy();
      void agent.destroy();
      settle();
    };
    const fail = (message: string): void => finish(() => reject(new Error(message)));
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming;
      incoming.on("error", () => fail("classifier response failed"));
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 299) {
        fail("classifier HTTP " + status);
        return;
      }
      if (status === 204 || status === 205) {
        fail("classifier response has no body");
        return;
      }
      const encoding = incoming.headers["content-encoding"];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        fail("unsupported classifier response encoding");
        return;
      }
      const declared = Number(incoming.headers["content-length"]);
      const declaredSize = Number.isFinite(declared) && declared >= 0 ? declared : undefined;
      if (declaredSize !== undefined && declaredSize > RESPONSE_LIMIT) {
        fail("classifier response too large");
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) {
          fail("classifier response too large");
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        if (declaredSize !== undefined && declaredSize > size) {
          fail("classifier response was truncated");
          return;
        }
        let text: string;
        try {
          text = RESPONSE_DECODER.decode(Buffer.concat(chunks));
        } catch {
          fail("invalid classifier response");
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          fail("invalid classifier response");
          return;
        }
        finish(() => resolve(parsed));
      });
    };
    if (spec.signal.aborted) {
      fail("classifier request was cancelled");
      return;
    }
    spec.signal.addEventListener("abort", onAbort, { once: true });
    try {
      ownedRequest = secure
        ? httpsRequest(spec.url, { method: "POST", headers: { ...spec.headers }, agent }, onResponse)
        : httpRequest(spec.url, { method: "POST", headers: { ...spec.headers }, agent }, onResponse);
    } catch {
      fail("classifier request failed");
      return;
    }
    ownedRequest.on("error", () => fail("classifier request failed"));
    try {
      ownedRequest.end(spec.body);
    } catch {
      fail("classifier request failed");
    }
  });
}

export function eligibleBackends(config: ProjectConfig, env: NodeJS.ProcessEnv): readonly TaskBackend[] {
  const backends: TaskBackend[] = [];
  if (config.backends.laya.enabled) backends.push("laya");
  const key = env.TYPESAFE_API_KEY;
  if (config.backends.jev.enabled && env.TURNHELM_ALLOW_HOSTED_JEV === "1"
    && typeof key === "string" && key.trim() !== "") {
    backends.push("jev");
  }
  return backends;
}

const CHOICE_INSTRUCTIONS =
  "Choose the lightest profile whose effort meets the task difficulty and correctness requirements.";

const CHOICE_CRITERIA: Readonly<Record<ProfileId, string>> = {
  fast: "Small localized work with clear requirements and acceptance checks",
  balanced: "Routine multi-file implementation and ordinary debugging",
  deep: "Complex debugging, review, or multi-step investigation",
  frontier: "Frontier architecture or reasoning beyond routine complexity",
  frontier_xhigh: "Frontier reasoning requiring extended effort beyond high",
  frontier_max: "The hardest reasoning work requiring maximum effort"
};

const ownObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

function validateChoice(reply: unknown): ProfileId {
  const envelope = ownObject(reply);
  if (!envelope || !Object.hasOwn(envelope, "answers")) throw new Error("classifier returned no route");
  const answers = ownObject(envelope.answers);
  if (!answers || !Object.hasOwn(answers, "route")) throw new Error("classifier returned no route");
  const route = ownObject(answers.route);
  if (!route) throw new Error("classifier returned no route");
  if (!Object.hasOwn(route, "type") || route.type !== "choice"
    || !Object.hasOwn(route, "choice") || typeof route.choice !== "string"
    || !(PROFILE_IDS as readonly string[]).includes(route.choice)) {
    throw new Error("classifier returned an invalid choice");
  }
  return route.choice as ProfileId;
}

export async function requestTaskChoice(
  config: ProjectConfig,
  task: string,
  backend: TaskBackend,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  request: ChoiceRequest = directChoiceRequest
): Promise<ProfileId> {
  const url = backend === "jev"
    ? new URL("/v1/systemone", "https://api.typesafe.ai")
    : new URL("/v1/systemone", config.backends.laya.url);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = backend === "jev" ? env.TYPESAFE_API_KEY : env.LAYA_API_KEY;
  if (backend === "jev" && (typeof key !== "string" || key.trim() === "")) {
    throw new Error("TYPESAFE_API_KEY is required");
  }
  if (typeof key === "string" && key.trim() !== "") headers.authorization = "Bearer " + key;
  const criteria: Record<string, string> = {};
  for (const id of PROFILE_IDS) criteria[id] = CHOICE_CRITERIA[id];
  const body = JSON.stringify({
    state: task,
    model: backend === "jev" ? "jev-latest" : "typed-decisions",
    questions: { route: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria } }
  });
  return validateChoice(await request({ backend, url, body, headers, signal }));
}
