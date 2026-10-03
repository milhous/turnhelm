# Phase A classifier boundary hardening

Date: 2026-10-03
Status: approved under the user's delegated authority; implementation pending

## Goal and evidence

Close the remaining classifier-input bypass, make offline verification independent
of developer credentials, reconcile the completed Phase A documentation, and
integrate the verified branch without rewriting existing history. The user has
authorized implementation, review, merge, and normal remote synchronization, with
long-term safety and performance prioritized over backward compatibility.

`resolvePhaseARoute` currently protects continuation text and inputs longer than
2000 UTF-16 code units, but exported `classifyTask` and `chooseProfile` bypass
that policy. The raw request builder is exported solely for tests. A separate
baseline run with classifier credentials unset passes only 18/19 tests: the Jev
fallback-success test relies on an inherited real API key. In addition, fetch's
default redirect behavior can leave the configured classifier origin.

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
