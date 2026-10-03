const continuation = /^(继续|接着做|按刚才的方案继续|continue|go on|proceed)[.!。！\s]*$/i;

export function localRoutingReason(prompt: string): "continuation" | "fallback" | undefined {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("task must not be empty");
  if (prompt.length > 2000) return "fallback";
  return continuation.test(prompt.trim()) ? "continuation" : undefined;
}
