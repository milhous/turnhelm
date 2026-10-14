// One shared runtime floor: CLI dispatch, doctor probes, and the classifier
// transport all refuse before doing work when the actual Node predates the
// proxy-capable Agent API this build requires.
export const MIN_NODE_VERSION: readonly [number, number, number] = Object.freeze([24, 5, 0]);

// Pure predicate over a version fact so tests can inject versions without
// executing on an old runtime; anything unparsable fails closed.
export function isSupportedNode(version: string = process.versions.node): boolean {
  const actual = version.split(".").map(part => Number.parseInt(part, 10));
  for (let index = 0; index < MIN_NODE_VERSION.length; index++) {
    const current = actual[index];
    if (!Number.isInteger(current)) return false;
    if (current !== MIN_NODE_VERSION[index]) return current > MIN_NODE_VERSION[index];
  }
  return true;
}
