import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { Agent as SecureAgent, request as httpsRequest } from "node:https";
import { PROFILE_IDS, type ProfileId, type ProjectConfig } from "./config.js";
import { isSupportedNode } from "./runtime.js";

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

// Bounded, frozen failure projection: only the kind, a status actually
// observed on an IncomingMessage (integers 100…599), and a whitelisted native
// code. Nothing parsed out of messages, causes, stacks, URLs, or headers.
export type ClassifierFailure = Readonly<{
  kind: "request" | "response" | "http" | "invalid-response" | "aborted" | "timeout" | "invalid-choice" | "unknown";
  httpStatus: number | null;
  code: "ENOTFOUND" | "EAI_AGAIN" | "ECONNREFUSED" | "ECONNRESET" | "ETIMEDOUT" | "CERT_HAS_EXPIRED" |
    "DEPTH_ZERO_SELF_SIGNED_CERT" | "ERR_TLS_CERT_ALTNAME_INVALID" | "UNABLE_TO_VERIFY_LEAF_SIGNATURE" | null;
}>;

export class ClassifierRequestError extends Error {
  readonly failure: ClassifierFailure;

  constructor(failure: ClassifierFailure, message: string) {
    super(message);
    this.failure = Object.freeze({ ...failure });
  }
}

const FAILURE_CODES: ReadonlySet<string> = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
]);

const UNKNOWN_FAILURE: ClassifierFailure = Object.freeze({ kind: "unknown", httpStatus: null, code: null });

// Rebuilds the whitelist projection only from the local typed error; any other
// exception, string, or value projects to unknown with nothing copied.
export function classifierFailure(error: unknown): ClassifierFailure {
  return error instanceof ClassifierRequestError ? error.failure : UNKNOWN_FAILURE;
}

export type TaskAttempt = Readonly<
  | { backend: TaskBackend; outcome: "success"; durationMs: number }
  | { backend: TaskBackend; outcome: "failed" | "timeout" | "cancelled"; durationMs: number; failure: ClassifierFailure }
>;

const RESPONSE_LIMIT = 8192;
const RESPONSE_DECODER = new TextDecoder("utf-8", { fatal: true });

const observedStatus = (status: number | undefined): number | null =>
  typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;

// Native codes are extracted only here at the capture boundary and only from
// the whitelist; a status of 0 or an absent code is not an HTTP response.
const failureCode = (error: unknown): ClassifierFailure["code"] => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && FAILURE_CODES.has(code) ? code as ClassifierFailure["code"] : null;
};

export function directChoiceRequest(spec: RequestSpec): Promise<unknown> {
  // Runtime floor first: an unsupported Node never creates an Agent, request,
  // or socket, whatever the caller asks for.
  if (!isSupportedNode()) {
    return Promise.reject(new ClassifierRequestError(
      { kind: "request", httpStatus: null, code: null },
      "classifier request refused on an unsupported runtime"));
  }
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
    const onAbort = (): void => fail("classifier request was cancelled", "aborted");
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      spec.signal.removeEventListener("abort", onAbort);
      ownedRequest?.destroy();
      response?.destroy();
      void agent.destroy();
      settle();
    };
    const fail = (message: string, kind: ClassifierFailure["kind"], status: number | null = null, error?: unknown): void =>
      finish(() => reject(new ClassifierRequestError({ kind, httpStatus: status, code: failureCode(error) }, message)));
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming;
      incoming.on("error", error => fail("classifier response failed", "response", observedStatus(incoming.statusCode), error));
      const status = incoming.statusCode ?? 0;
      if (status < 200 || status > 299) {
        fail("classifier HTTP " + status, "http", observedStatus(incoming.statusCode));
        return;
      }
      if (status === 204 || status === 205) {
        fail("classifier response has no body", "response", observedStatus(incoming.statusCode));
        return;
      }
      const encoding = incoming.headers["content-encoding"];
      if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
        fail("unsupported classifier response encoding", "response", observedStatus(incoming.statusCode));
        return;
      }
      const declared = Number(incoming.headers["content-length"]);
      const declaredSize = Number.isFinite(declared) && declared >= 0 ? declared : undefined;
      if (declaredSize !== undefined && declaredSize > RESPONSE_LIMIT) {
        fail("classifier response too large", "response", observedStatus(incoming.statusCode));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      incoming.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) {
          fail("classifier response too large", "response", observedStatus(incoming.statusCode));
          return;
        }
        chunks.push(chunk);
      });
      incoming.on("end", () => {
        if (declaredSize !== undefined && declaredSize > size) {
          fail("classifier response was truncated", "invalid-response", observedStatus(incoming.statusCode));
          return;
        }
        let text: string;
        try {
          text = RESPONSE_DECODER.decode(Buffer.concat(chunks));
        } catch {
          fail("invalid classifier response", "invalid-response", observedStatus(incoming.statusCode));
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          fail("invalid classifier response", "invalid-response", observedStatus(incoming.statusCode));
          return;
        }
        finish(() => resolve(parsed));
      });
    };
    if (spec.signal.aborted) {
      fail("classifier request was cancelled", "aborted");
      return;
    }
    spec.signal.addEventListener("abort", onAbort, { once: true });
    try {
      ownedRequest = secure
        ? httpsRequest(spec.url, { method: "POST", headers: { ...spec.headers }, agent }, onResponse)
        : httpRequest(spec.url, { method: "POST", headers: { ...spec.headers }, agent }, onResponse);
    } catch (error) {
      fail("classifier request failed", "request", null, error);
      return;
    }
    ownedRequest.on("error", error => fail("classifier request failed", "request", null, error));
    try {
      ownedRequest.end(spec.body);
    } catch (error) {
      fail("classifier request failed", "request", null, error);
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

export type TaskChoice = Readonly<{ profileId: ProfileId; confidence?: number }>;

function validateChoice(reply: unknown, backend: TaskBackend): TaskChoice {
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
  // Confidence is required by the hosted protocol and optional on a local backend;
  // anything outside [0, 1] is treated as absent rather than trusted.
  const confidence = route.confidence;
  return typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
    ? { profileId: route.choice as ProfileId, confidence }
    : { profileId: route.choice as ProfileId };
}

export async function requestTaskChoice(
  config: ProjectConfig,
  task: string,
  backend: TaskBackend,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  request: ChoiceRequest = directChoiceRequest
): Promise<TaskChoice> {
  // Temporary until the shared proxy transport lands: an enabled
  // http-connect Jev policy is refused here, before any request (seam or
  // default), so a proxy policy can never silently run the direct path.
  if (backend === "jev" && config.backends.jev.transport.mode === "http-connect") {
    throw new ClassifierRequestError(
      { kind: "request", httpStatus: null, code: null },
      "jev http-connect transport is not available in this build; no request was made");
  }
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
  const reply = await request({ backend, url, body, headers, signal });
  try {
    return validateChoice(reply, backend);
  } catch (error) {
    // Choice validation is local: a successful direct reply carries no HTTP
    // metadata, so invalid-choice allows a null status. Messages stay fixed.
    throw new ClassifierRequestError(
      { kind: "invalid-choice", httpStatus: null, code: null },
      error instanceof Error ? error.message : "classifier returned an invalid choice"
    );
  }
}
