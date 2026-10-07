const continuation = /^(继续|接着做|按刚才的方案继续|continue|go on|proceed)[.!。！\s]*$/i;

export function localRoutingReason(prompt: string): "continuation" | "fallback" | undefined {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("task must not be empty");
  if (prompt.length > 2000) return "fallback";
  return continuation.test(prompt.trim()) ? "continuation" : undefined;
}

const MAX_TASK_BYTES = 8192;
const TASK_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const TASK_ENCODER = new TextEncoder();
const CONTINUATION_TASK = /^(?:continue|go on|proceed|do the above|继续|接着做|按刚才的方案继续|按上面做)[.!。！\s]*$/i;

type TaskStdin = NodeJS.ReadableStream & { isTTY?: boolean };

const destroyStdin = (stdin: TaskStdin): void => {
  (stdin as unknown as { destroy(): void }).destroy();
};

const checkTask = (task: string): string => {
  if (task.includes("\0")) throw new Error("task must not contain NUL");
  if (!task.trim()) throw new Error("task must not be blank");
  if (CONTINUATION_TASK.test(task.trim())) throw new Error("task is a continuation-only instruction, not a task");
  return task;
};

export function validateTask(input: string | Uint8Array): string {
  if (typeof input === "string") {
    if (input.length > MAX_TASK_BYTES) throw new Error("task exceeds 8192 bytes");
    const bytes = TASK_ENCODER.encode(input);
    if (bytes.length > MAX_TASK_BYTES) throw new Error("task exceeds 8192 bytes");
    if (TASK_DECODER.decode(bytes) !== input) throw new Error("task contains invalid Unicode");
    return checkTask(input);
  }
  if (input.length > MAX_TASK_BYTES) throw new Error("task exceeds 8192 bytes");
  return checkTask(TASK_DECODER.decode(input));
}

const collectInput = (stdin: TaskStdin, signal?: AbortSignal): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const fail = (error: unknown) => {
      destroyStdin(stdin);
      finish(() => reject(error));
    };
    const onData = (chunk: unknown) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      total += bytes.length;
      if (total > MAX_TASK_BYTES) {
        fail(new Error("task exceeds 8192 bytes"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(() => resolve(Buffer.concat(chunks)));
    const onError = (error: unknown) => fail(error);
    const onAbort = () => fail(new Error("task input was cancelled"));
    if (signal?.aborted) {
      fail(new Error("task input was cancelled"));
      return;
    }
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function readTask(positional: string | undefined, stdin: TaskStdin, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    destroyStdin(stdin);
    throw new Error("task input was cancelled");
  }
  if (stdin.isTTY) {
    if (positional === undefined) throw new Error("a task is required as an argument or on stdin");
    return validateTask(positional);
  }
  const bytes = await collectInput(stdin, signal);
  if (positional !== undefined) {
    if (bytes.length > 0) throw new Error("task must come from an argument or stdin, not both");
    return validateTask(positional);
  }
  return validateTask(bytes);
}
