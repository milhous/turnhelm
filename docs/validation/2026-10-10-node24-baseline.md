# Node 24 baseline validation record

Execution date: 2026-10-10 (GMT+8, ~21:35–21:55). Spec:
[Node 24 convergence spec](../superpowers/specs/2026-10-10-node24-unresolved-remediation-design.md).
Plan: [implementation plan](../superpowers/plans/2026-10-10-node24-unresolved-remediation.md).

- Code baseline: `891abdd3658c49a63c94500ea502bbf70f2b5efa` on
  `feat/paid-chain-validation`, plus the uncommitted working-tree changes this
  record validates: `package.json`, `src/doctor.ts`, `README.md`,
  `.agents/skills/turnhelm-routing/SKILL.md`, `test/doctor.test.ts`,
  `test/direct-transport.test.ts`, `test/package.test.ts`, and this record.
  The two `docs/superpowers/` spec/plan drafts were already untracked at start.
- Runtime: `node` `/Users/zhangxiao/.nvm/versions/node/v24.11.0/bin/node`
  v24.11.0 (`24.x >= 24.5.0`, satisfies the acceptance requirement);
  `pnpm` 10.12.1. No global defaults changed; Node 24 was selected per command
  via `PATH`.

## N24-01 — version floor is consistent across all surfaces

- `package.json` `engines.node` is exactly `>=24.0.0`.
- `src/doctor.ts` `NODE_FLOOR` is `[24, 0, 0]`; the failure hint is exactly
  `upgrade node to 24.0.0 or newer`.
- New test `doctor node floor is 24.0.0` (non-concurrent, full property
  descriptor save/try/finally restore) proves the boundary: `22.8.0` and
  `23.99.99` fail with the new hint; `24.0.0`, `24.0.1`, `25.0.0` pass; zero
  classifier requests; descriptor restored bit-for-bit afterwards. Watched RED
  first (old floor passed `22.8.0`) before the floor change made it green.
  Simulating 23/25 is a boundary unit test, not an execution of those versions.
- The unmocked offline doctor test additionally asserts the real runtime's
  node check passes (actual Node 24.11.0).
- README and the shared `turnhelm-routing` skill state Node `>=24.0.0`,
  dropped 22.8 support, and validation on an actual `24.x >=24.5.0`. The
  packed distribution ships these texts (asserted in the package test).

## N24-02 — Node 22 personal paths and skip branches retired

- Removed from `test/direct-transport.test.ts`: the `NODE_22` personal
  absolute path constant, the standalone
  `direct transport ignores an enabled environment proxy (node 22.8.0)` test
  with its binary-missing skip branch, and the then-unused `existsSync`
  import. This is a justified retirement per spec §4.2 — the retired test is
  NOT counted as passing anywhere.
- Denominator effect: the 891abdd CI recorded 364 tests / 363 pass / 1 skip;
  this tree adds one doctor floor test, removes the Node 22 test, and leaves
  zero skip branches: 364/364 pass, 0 skipped.

## N24-03 — activated-proxy evidence is non-vacuous; full suite on real 24.5+

In both existing `NO_PROXY` scenarios (absent and empty string) of the proxy
child test, on the same controlled child environment
(`NODE_USE_ENV_PROXY=1`, four proxy variables at the loopback sentinel,
`NODE_OPTIONS` cleared):

1. A positive control child first makes a plain default-agent `http.get`
   (no explicit agent) and must consume the sentinel's `proxied` reply: the
   proxy gains exactly one request and the target gains none. The control leg
   is selected only when the runtime is `major > 24 || (major === 24 &&
   minor >= 5)`; on 24.0–24.4 the direct assertions still run but are not
   claimed as activated-proxy evidence.
2. The production `directChoiceRequest` child then runs under the same
   environment: zero additional proxy requests, exactly one target request,
   and the choice still resolves `fast`.

Fault sensitivity was demonstrated once on this fixture: forcing the control
child's `NODE_USE_ENV_PROXY=0` made the `CONTROL proxied` assertion fail (the
control went direct to the target instead); restoring the fixture made it
pass again. No production agent or user code was modified.

Commands (all exit 0; run serially, one dist rebuild each):

| Command (Node 24.11.0, credentials unset) | Result |
| --- | --- |
| `node --test dist/test/{doctor,direct-transport,init,package,worker,preflight}.test.js` | 180/180 pass, 0 fail/cancel, 0 skipped. |
| `pnpm test` | 364/364 pass, 0 fail/cancel, 0 skipped (~45s). |
| `pnpm run test:coverage` | 364/364 pass; lines 94.99%, branches 89.66%, functions 94.12% — each >=80%. |
| `pnpm audit --audit-level high` | Completed successfully: `No known vulnerabilities found` (not a timeout). |
| `git diff --check` | Clean. |

## N24-04 — dependency audit

`pnpm audit --audit-level high` at this snapshot: no known vulnerabilities,
exit 0, full successful result. Audit is a registry query only.

## N24-05 — offline pack/install and installed-bin checks

The existing package test (real `pnpm pack` → temporary Git consumer with
spaces in its path → `pnpm add --offline --ignore-scripts` → installed bin)
now also asserts: the installed `package.json` engines is `>=24.0.0`; the
packed README and shipped skill carry the new Node requirement texts; the
installed `doctor --json` reports node status `pass` on the actual runtime.
The new assertions were watched RED against the pre-change docs/engines and
green after restoring them. Package whitelist, path-with-spaces,
offline/ignore-scripts, fake Codex, init idempotence, and conflict protection
assertions are unchanged and passing. No registry install, no real backend,
no workers.

## Unverified boundaries

- The activated-proxy control runs only on 24.5+; this record does not claim
  24.0–24.4 or any future Node version was executed or proven.
- No real classifier, worker, `test:live`, or `doctor --probe` ran in this
  validation. NAT/JEV/CAL/META open questions from the spec are untouched.
- These results validate the uncommitted working tree at `891abdd`; CI status
  for this exact snapshot will exist only after an authorized commit/push.
- Historical records (including the earlier Node 22.8/Node 26 evidence in
  `2026-10-08-turnhelm-task-entry.md`) are retained unchanged and are not
  superseded except where this record states the current Node commitment.
