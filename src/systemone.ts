import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as SecureAgent, request as httpsRequest } from "node:https";
import { PROFILE_IDS, type ProfileId, type ProjectConfig } from "./config.js";

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
    ? new SecureAgent({ keepAlive: false, proxyEnv: {}, rejectUnauthorized: true })
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
  "Choose the lightest profile that meets the task's requirements, judged by uncertainty, coupled constraints, "
  + "required verification, and the consequences of an incorrect result; never by prompt length, file count, "
  + "or keywords such as security, architecture, or deep analysis.";

const CHOICE_CRITERIA: Readonly<Record<ProfileId, string>> = {
  fast: "Small localized work with clear requirements and acceptance checks.",
  balanced: "Routine implementation and debugging with bounded scope.",
  deep: "Difficult but bounded debugging, review, and multistep reasoning.",
  frontier: "Very difficult work with ambiguity and interacting cross-system constraints.",
  frontier_xhigh: "Demanding reasoning requiring detailed argument and verification across several constraints.",
  frontier_max: "Exceptional problems requiring the greatest single-worker reasoning depth."
};

const ownObject = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

function validateChoice(reply: unknown, backend: TaskBackend): ProfileId {
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
  if (backend === "laya" && Object.hasOwn(envelope, "usage")) {
    const usage = ownObject(envelope.usage);
    if (!usage || !Object.hasOwn(usage, "truncated") || usage.truncated !== false
      || !Object.hasOwn(usage, "state_tokens_dropped") || usage.state_tokens_dropped !== 0) {
      throw new Error("classifier returned truncated or invalid Laya usage");
    }
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
    // Do not inherit Laya's 1024-token checkpoint window for a complete task.
    ...(backend === "laya" ? { max_len: 8192 } : {}),
    questions: { route: { type: "choice", instructions: CHOICE_INSTRUCTIONS, criteria } }
  });
  return validateChoice(await request({ backend, url, body, headers, signal }), backend);
}
