# Phase A classifier boundary hardening

Date: 2026-10-03
Status: final-review safety fixes verified; controller review/integration pending (2026-10-03)

## Goal and evidence

Close the remaining classifier-input bypass, make offline verification independent
of developer credentials, reconcile the completed Phase A documentation, and
integrate the verified branch without rewriting existing history. The user has
authorized implementation, review, merge, and normal remote synchronization, with
long-term safety and performance prioritized over backward compatibility.

Before hardening, `resolvePhaseARoute` protected continuation text and inputs
longer than 2000 UTF-16 code units, but exported `classifyTask` and `chooseProfile`
bypassed that policy. The raw request builder was exported solely for tests. A
baseline run with classifier credentials unset passed only 18/19 tests: the Jev
fallback-success test relied on an inherited real API key. In addition, fetch's
default redirect behavior could leave the configured classifier origin.

Initial implementation verification on 2026-10-03 passed 168/168 hermetic tests on Node
24.21.0 and 26.5.0. Every production module exceeded 80% source lines, branches,
and functions; aggregate coverage was 99.10%, 93.39%, and 100%, respectively.
Dependency audit reported zero vulnerabilities. CLI characterization uses only
ephemeral loopback fixtures and a temporary executable, preserving child
coverage. The authorized live smoke evidence is unchanged; no new live calls
were made. Independent review and publication remain controller-owned gates.

Final boundary verification passed 189/189 hermetic tests and coverage tests on
exact Node 22.8.0 with bundled npm 10.8.2, official Node 24.21.0, and native
Node 26.5.0. Aggregate source lines/branches/functions were
99.25%/93.06%/100% on every target; every production module exceeded 80%.
The focused RED receipt was 130/152, with 22 expected boundary/fixture failures;
GREEN was 152/152 on all three targets. Dependency audit remained clean.
The exact-minimum verification closes the earlier implicit-module fixture gap.

CLI characterization also exposed `.join(" ").trim()` normalizing original
task text and allowing padded overlong input to reach classification. The
authorized minimal fix preserves the joined string and uses `prompt.trim()`
only to reject blank usage. The focused CLI RED checkpoint had 13/16 passing
tests with three expected failures; after the two-line correction, 16/16 pass,
including unchanged padded/newline classifier state and Codex stdin in both
sandbox modes, and zero fetches for padded 2001-unit input.

## Decision and alternatives

Use one small pure task-policy module shared by routing and the classifier
boundary. Remove the raw request builder's export and test wire requests through
the real public classifier function. Reject HTTP redirects. Use isolated dummy
credentials in offline tests.

Duplicating validation at every helper would be smaller initially but would
allow policy drift. Removing every classifier export would shrink the interface
further, but would hide classifier failures behind fallback in the existing
live smoke harness. The selected approach retains a useful strict classifier
boundary without a second routing policy or additional dependencies.

## Contract

- Empty or non-string task input is rejected without fetching.
- The classifier limit is exactly 2000 JavaScript UTF-16 code units, measured on
  the original task. Exactly 2000 is eligible; 2001 is not.
- Existing bilingual continuation detection remains local-only.
- `resolvePhaseARoute` continues to select the configured fallback for overlong
  or continuation input, or fails before a backend call when none is configured.
- Direct `classifyTask` or `chooseProfile` calls reject overlong or continuation
  input before backend selection, opt-in checks, request serialization, or fetch.
- Eligible tasks are sent unchanged. There is no truncation or normalization of
  the task transmitted to the classifier or the Codex child.
- The CLI preserves its joined task string, including leading/trailing
  whitespace and newlines; trimming is used only for blank-input validation.
- The request builder becomes private. Every classifier fetch uses
  `redirect: "error"`; redirects are backend failures, never alternate origins.
- Existing hosted-Jev config/environment/key gates and the single Laya-to-Jev
  fallback transition remain unchanged. No retries, confidence policies,
  Gateway, Hook, catalog, or native subagent integration are introduced.
- Offline tests use dummy keys and restored environment/fetch state only. They
  must pass with real classifier credentials absent.
- Source coverage must reach at least 80% for lines, branches, and functions,
  using Node's built-in coverage, including CLI/child-process smoke coverage.
- Persist offline coverage and dependency-audit gates in a minimal GitHub
  Actions workflow. Pin actions to verified official commit SHAs, grant only
  `contents: read`, disable persisted checkout credentials, and do not expose
  classifier credentials. Node's required coverage threshold flags were added
  in 22.8.0; the development/runtime floor becomes `>=22.8.0` and CI uses the
  supported Node 24 line. See the [official Node CLI source](https://github.com/nodejs/node/blob/v22.x/doc/api/cli.md#--test-coverage-branchesthreshold).
- No paid live rerun is necessary: the existing authorized smoke evidence is
  preserved and explicitly dated rather than presented as a new live run.

## Final-review safety amendments

The full unpublished-history review identified four concrete gaps to close
before publication. These decisions use the user's delegated authority.

- The temporary extensionless Codex fixture must use explicit CommonJS-safe
  asynchronous code, not implicit module detection. Verify exact minimum Node
  22.8.0 as well as Node 24/26; this is a deterministic test-format correction.
- Handle child stdin errors before writing, and settle the Codex promise only
  after process/stdio completion. Preserve nonzero child statuses; an input
  transfer failure must not report success even if the child exits zero.
  Spawn failures remain controlled rejections. Do not add a global Codex task
  timeout, retry, model switch, or permission policy.
- Classifier responses are limited to 64 KiB (65536) received UTF-8 bytes.
  Reject oversized declared Content-Length before reading, and enforce the
  actual streamed byte count even when the header is absent or understated.
  Cancel/release the reader on overflow or failure, retain the four-second
  request abort, and parse JSON only after the bounded read. Malformed JSON,
  invalid UTF-8, absent body, and stream errors produce generic errors without
  response excerpts. Exactly 65536 bytes is allowed; 65537 is rejected.
- Use `Object.hasOwn` for the classifier choice allowlist, including ordinary
  structurally valid Config objects, while retaining legitimate own profile IDs.

These are stateless boundary corrections, not a new routing subsystem.

## Verification and integration

Follow test-first RED/GREEN checkpoints on `feat/phase-a-local-first`, retaining
the existing user preference to work in the current checkout. Run hermetic
tests, coverage, dependency audit, whitespace checks, and an independent review.
Synchronize the Phase A spec status, execution checkboxes, and local ledger.
Before publication, scan the entire unpublished history for secrets and review
the final diff. Fetch remote state; normally push the reviewed feature branch
and require its offline CI to pass before fast-forwarding main. Use only
fast-forward integration and a normal non-force push. If the remote has diverged, stop automatic publication
and preserve both histories. Do not change credentials, branch protections, or
user Codex configuration.
