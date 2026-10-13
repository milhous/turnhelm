// WH-2: the adjudicated stdout envelope — the contract object on line 1 plus
// any number of inert trailer lines. A trailer is inert only when it parses
// as no JSON value, opens with no object, array, or string (after optional
// whitespace), and is no code-fence delimiter; anything else could carry a
// second structured payload past the oracle.
export const inertTrailerLine = (line: string): boolean => {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith("\"")) return false;
  if (trimmed.startsWith("```")) return false;
  try { JSON.parse(line); return false; } catch { return true; }
};

// VH-5: the payload-agnostic envelope fact — line 1 must parse as a JSON
// value, and every remaining line must be inert. The value is returned
// unvalidated; each consumer applies its own predicate to it.
export function envelopePayload(text: string): { value: unknown } | null {
  const lines = text.split("\n");
  let value: unknown;
  try {
    value = JSON.parse(lines[0]) as unknown;
  } catch {
    return null;
  }
  return lines.slice(1).every(inertTrailerLine) ? { value } : null;
}

const PAYLOAD_ENCODER = new TextEncoder();

const parsesAsJson = (text: string): boolean => {
  try { JSON.parse(text); return true; } catch { return false; }
};

export type PayloadMode = "strict" | "extracted" | "conflict" | "unstructured";

export type PayloadClassification = Readonly<{
  mode: PayloadMode;
  emittedText: string;
  trailerBytes?: number;
}>;

// PE-1 §3.2: the emission classifier over the frozen envelope discipline.
// emittedText is the extractor text — the emitter's "\n" append stays outside
// the classifier. strict and unstructured are the whole message verbatim;
// extracted carries exactly the first line plus the UTF-8 byte length of
// everything after its terminating newline; conflict keeps a non-inert
// trailer whole so a second structured answer is never silently dropped.
export function classifyPayload(message: string): PayloadClassification {
  if (parsesAsJson(message)) return { mode: "strict", emittedText: message };
  const lines = message.split("\n");
  if (!parsesAsJson(lines[0])) return { mode: "unstructured", emittedText: message };
  const trailer = lines.slice(1).join("\n");
  if (!lines.slice(1).every(inertTrailerLine)) return { mode: "conflict", emittedText: message };
  return { mode: "extracted", emittedText: lines[0], trailerBytes: PAYLOAD_ENCODER.encode(trailer).length };
}
