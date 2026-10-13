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
