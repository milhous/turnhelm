# Host-Pointer Closure Design

Date: 2026-10-19. Code baseline: `29d7a5578d02843242556d2fc23b3ce7c3090346` (main).

> Status: the user requested a fresh branch, a spec driven only by long-term benefit, security, and
> performance (no backward-compatibility constraints), an independent Astra review with gap-finding
> and over-engineering control, a revised spec, and an execution plan. Current authority covers that
> review plus English documentation and local commits on this branch — not implementation, live
> provider calls, publication, or service/authentication/proxy changes. All prior campaign
> authorities remain closed.

## 1. Problem and evidence boundary

The sealed 106-case campaign at `29d7a55` settled **COMPLETE-WITH-POLICY-MISMATCH**: 106 pass,
0 failed, 0 unjudged timeouts, and 3 calibration policy mismatches that are policy observations,
not engineering failures. Input report (private local evidence):
`/Users/zhangxiao/.local/state/turnhelm/validation-20261019-29d7a55-tmv2wvf7/final-report-v2/REPORT.md`.
The only code-side boundary residual that survives its evidence fences is the environment-pointer
class the repository itself documents:

| Observation | Established fact | Not established |
| --- | --- | --- |
| Boundary attestations | 82/82 workers ran with hermetic `HOME`/`ZDOTDIR`/`CODEX_HOME` and stripped classifier keys (`hermeticHomeObserved`, `startupAndClassifierKeysAbsent`) | Host-secret isolation; all-descendant absence — the report keeps both "unverified" |
| Code-documented residual | `workerEnvironment` passes every other inherited variable through, including explicit override pointers (`XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `NPM_CONFIG_USERCONFIG`, …) — `src/codex.ts:92-111` names them as documented residuals | That any campaign case was affected; this is a standing boundary property, not an observed leak |
| Action-capable pointers | `SSH_AUTH_SOCK`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `KUBECONFIG`, `AWS_*` file pointers inherit into the worker when the host exports them; a socket use is an authentication/control action, not a file read, so it is not covered by the hermetic-`HOME` redirect or the read sandbox story | An actual misuse; reachability in this campaign's environment |
| Routing policy | `heading-en-trial-1/2/3` selected `frontier` outside their bands; the 2026-10-12 criteria experiment (200 free local calls, 15 revisions) ended sealed: no revision beat draft f, every fix flipped another gated item | Any fixable-in-code cause; band hypotheses are not ground truth |

Reading of the current code (all at the baseline): `subprocessEnvironment` strips the two classifier
keys, the two Turnhelm override keys, `BASH_ENV`/`ENV`, and voids `NODE_V8_COVERAGE`
(`src/codex.ts:72-90`); `workerEnvironment` additionally redirects `HOME`/`ZDOTDIR`/`CODEX_HOME`
to the per-run managed home and sets `TURNHELM_MANAGED_CHILD` (`src/codex.ts:92-111`);
`OPENAI_API_KEY` and the `auth.json` symlink are the worker's intended credential path
(`src/codex.ts:113-144`) and are untouched by this design. This design closes exactly one surface:
the inherited host-pointer class. Nothing else enters through it.

## 2. Decision and scope

**Close the explicit host-pointer residual with one fixed, versioned scrub list applied at the
worker boundary, attest its generation on the worker receipt, and align the boundary documentation —
a small, bounded, evidence-honest change.** No new subsystem, config version, manifest axis, or
default behavior beyond the scrub itself.

| Alternative | Decision |
| --- | --- |
| Scrub a fixed list of host pointer variables in `workerEnvironment` | Adopt: turns the largest documented env residual into a closed set with a generation tag |
| Attest the scrub generation on the worker receipt (`envBoundary` tag) | Adopt: the `instructionNote`/`codexHomeManaged` idiom — campaigns can distinguish boundary generations without re-deriving from source SHAs |
| Retry routing-criteria retuning for the heading-en mismatch | Reject: sealed exhausted 2026-10-12 (200/200 calls, gates blocked); the mismatch is a recorded policy observation, not an engineering defect |
| Forced demotion, light-task keyword rules, confidence thresholds or caps | Reject: sealed rejection 2026-10-11 (sample fitting against unfalsifiable bands) |
| Wire stall abort into standard live acceptance | Reject: cost/benefit unchanged — this campaign observed zero timeouts, and the prepare surface stays frozen |
| Redirect `TMPDIR` to a managed directory | Reject: no observed need; the managed home already lives under `tmpdir()` on the same filesystem. Named here so the residual stays visible |
| Pattern-based scrubbing (any `*_CONFIG*`/`*HOME*`/unknown keys) | Reject: an unprincipled denylist that grows silently; the list is source-frozen and version-tagged, and growth is a new tag |
| Scrub program pointers (`PATH`, `SHELL`, `EDITOR`, …) | Reject: the worker must run host tools; the closure covers data/config/credential pointers and action sockets only |
| Proxy-exit attestation, `AGENTS.override.md`, admin-hook closure | Reject: not closable from this repository or requires unverifiable external proof |
| Regrade or reinterpret any sealed campaign case | Reject: forbidden by the report's authority closure |

Unchanged: routing and classifier contracts (including `CHOICE_INSTRUCTIONS`/`CHOICE_CRITERIA`),
config v2 shape, task 8192-byte validation, managed `CODEX_HOME`/auth-symlink lifecycle and
credential gate, sandbox selection per `--write`, the note and stall-watchdog mechanisms from the
prior design, output-schema staging, payload framing, failure taxonomy, stop order,
exactly-one-receipt behavior, exit codes, and all consumer gates. `subprocessEnvironment`'s
credential strip and its `preflight` callers are untouched — the scrub applies to the worker
boundary only.

## 3. Normative contract

### 3.1 Fixed host-pointer scrub

`workerEnvironment` additionally deletes exactly these inherited keys, alphabetically frozen in
source:

```
AWS_CONFIG_FILE, AWS_SHARED_CREDENTIALS_FILE, DOCKER_CONFIG, DOCKER_CONTEXT, DOCKER_HOST,
GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM, KUBECONFIG, NPM_CONFIG_USERCONFIG, SSH_AUTH_SOCK,
XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR, XDG_STATE_HOME
```

Principle, stated once in the code comment: a key is on the list iff its value is a host
**data/config/credential discovery pointer** (it redirects a tool's default file discovery away
from the managed home: the `XDG_*`, `GIT_CONFIG_*`, `NPM_CONFIG_USERCONFIG`, `DOCKER_CONFIG`,
`AWS_*`, `KUBECONFIG` families) or an **action-capable pointer** (its value names a socket or
endpoint whose use authenticates or controls host resources without reading a file:
`SSH_AUTH_SOCK`, `DOCKER_HOST`, `DOCKER_CONTEXT`). Program pointers (`PATH`, `SHELL`, …) are
deliberately not on the list; nor is `OPENAI_API_KEY`, which is the worker's intended credential.
The list is exhaustive by construction — no pattern matching, no partial match, no key outside the
list is ever touched, and adding or removing a key is a source change that bumps the version tag
below. Deletion semantics match the existing credential strip (own-property delete; the managed
overrides `HOME`/`ZDOTDIR`/`CODEX_HOME`/`TURNHELM_MANAGED_CHILD` still win as today).

Behavior change, documented rather than mitigated: a worker that needs host configuration or
credentials reachable only through these pointers must receive them through the task's own inputs —
the same consequence class the hermetic-`HOME` design already documents. Staging host pointers back
in would undo the closure. System-level files outside any home (e.g. `/etc/gitconfig` reached
without `GIT_CONFIG_SYSTEM`), managed/admin hook layers outside `CODEX_HOME`, a project
`AGENTS.override.md`, absolute host file reads by an authorized worker, and the host filesystem
boundary itself remain documented residuals — the sandbox owns those, not the environment.

### 3.2 Boundary-generation attestation

The worker result gains `envBoundary: "host-pointers-v1"`, present iff the run's worker environment
was built with the §3.1 scrub — a mechanism attestation in the `codexHomeManaged`/`instructionNote`
honesty class, never a claim that a descendant failed to re-import anything. The tag shape is
`^host-pointers-v\d+$`; a generation change (list edit) is a new tag, never a silent edit — the
same discipline as `sandbox-semantics-v1`. If the tag is absent, the scrub generation is not
attested; nothing is inferred from absence.

### 3.3 Evidence projections

The tag rides the same three surfaces `instructionNote` rides, with the same per-field discipline
(absent, malformed, or out-of-pattern values drop the field; never coerce, never fabricate):
custom-round's `projectWorkerReceipt` whitelist admits `envBoundary` beside `instructionNote`;
standard acceptance's observed record gains one optional bounded `envBoundary` field for every
executed worker regardless of status; the CLI receipt carries it on the worker object. Routes and
journal schemas, sealed-archive shapes, and every existing projection are otherwise unchanged; no
historical record is regraded or rewritten.

### 3.4 Privacy, performance, and interpretation

The scrub is fifteen own-property deletions on an object built once per spawn — constant cost, no
allocation beyond the existing copy, no new I/O, dependency, persistent state, or network
operation. No environment value is ever logged, hashed, or retained: the receipt carries the
generation tag only.

Interpretation fences: the scrub changes what the worker environment contains, not what a
descendant does; the attestation is mechanism evidence, not obedience; closing env pointers does
not close the host filesystem read boundary, the proxy-exit question, or sandbox enforcement.
Offline fixtures verify the env contract and evidence surfaces only — they cannot establish that
any real campaign environment exported a listed pointer, and absence of a key in a sample is not
proof of absence everywhere.

## 4. Connected implementation surface

This is a future implementation boundary, not implementation authorization. The later change must
cover all connected consumers in one contract:

| Surface | Required responsibility |
| --- | --- |
| `src/codex.ts` | The frozen §3.1 list + principle comment; deletions in `workerEnvironment`; `envBoundary` on `WorkerResult` set iff the scrub ran |
| `src/cli.ts` | `envBoundary` wired through the explicit receipt construction; nothing else |
| `test/worker.test.ts` | Hostile-pointer fixtures: every listed key exported by a hostile host is absent in the worker env and in a surviving descendant; unlisted variables (including `PATH`, `SHELL`, `OPENAI_API_KEY`, an unlisted `XDG_`-prefixed key if any exists) still pass through; parent process env unchanged; the existing XDG-passthrough assertion is updated, not deleted; `subprocessEnvironment`/preflight paths unchanged |
| `test/cli.test.ts` | The receipt carries `envBoundary: "host-pointers-v1"` on every executed-worker path |
| `test/custom-round.ts` | `projectWorkerReceipt` whitelist admits the tag (pattern-validated, drops malformed/out-of-pattern alone) |
| `test/live-acceptance.ts` | Observed record gains the optional bounded `envBoundary` field for completed, failed, and cancelled workers alike |
| `test/custom-round.test.ts`, `test/live-acceptance.test.ts`, `test/codex.test.ts` | Whitelist round-trips incl. malformed tags; projection drop rules |
| `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` (+ `.claude` mirror) | Boundary passages rewritten: the override-variable residual list shrinks to system files/hooks/override-file/absolute-read residuals; the consequence class (in-task inputs) stated; tag named |
| `test/package.test.ts`, `test/init.test.ts` | Update only packaged-documentation assertions genuinely changed |

Use synthetic fixtures inside existing test helpers. No compatibility adapter, migration, config
version bump, manifest version bump, or env knob is introduced — the scrub is unconditional at the
worker boundary. Update exact-key/text assertions reached by this contract; do not weaken security
or coverage gates to make them pass. Avoid unrelated cleanup.

## 5. Acceptance criteria for later implementation

All criteria are offline; fake workers make no real provider request.

1. **Scrub contract:** for every key of the frozen list, a hostile host exporting that key (with a
   plausible value, e.g. a planted socket path or config path) produces a worker environment where
   the key is absent — checked both on the built env object and through a real spawned worker that
   dumps its env; a surviving descendant re-sampling after leader exit sees the same absence.
2. **Precision:** unlisted variables keep passing through exactly as today — including `PATH`,
   `SHELL`, `TMPDIR`, `OPENAI_API_KEY`, `NODE_OPTIONS`, and at least one unlisted `XDG_`-suffixed
   key (e.g. a hypothetical `XDG_SENTINEL`) — and the parent CLI process environment is unchanged
   by a run. The managed overrides (`HOME`, `ZDOTDIR`, `CODEX_HOME`, `TURNHELM_MANAGED_CHILD`) and
   the existing `subprocessEnvironment` strips behave identically to the baseline.
3. **Attestation:** the receipt carries `envBoundary: "host-pointers-v1"` on completed, failed, and
   cancelled workers alike; custom-round retains it through `projectWorkerReceipt` and drops
   malformed or out-of-pattern values alone; standard acceptance retains it on the observed record
   for every executed worker; unselected keys keep being ignored per each projector's existing
   rules.
4. **No scope creep:** `subprocessEnvironment` output is unchanged (its `preflight` callers
   unaffected); no new config field, CLI flag, manifest axis, or journal key exists; `git grep`
   finds the list exactly once in `src/`.
5. **Privacy canaries:** no environment value, path string, or socket path beyond the fixed tag
   reaches journals, projections, or diagnostics; existing redaction surfaces unchanged.
6. **Regression commands:** build/typecheck, focused suites, full `pnpm test`, stock
   `pnpm test:coverage` with existing 80% gates, dependency audit, `git diff --check`, scoped-diff
   and README/skill alignment review. No live command belongs to this stage.

## 6. Next decision boundary and non-goals

The companion [execution plan](../plans/2026-10-19-host-pointer-closure.md) returns to the user
with this spec. Implementation and offline verification start only after the user's
execution-method decision. The report's live-coverage gaps — an induced live stall to prove
watchdog firing on a real worker, direct non-proxy Jev, native API-key billing, deliberate
credential refresh, rate/usage limits, and operator cancellation — are candidates for future
finite campaigns only: each needs a fresh manifest/SHA approval with explicit cases, caps,
predeclared stop rules, and matched controls, changing one variable at a time. Do not replay the
sealed campaign or reuse its authorities.

Excluded: routing-criteria retuning and any demotion/cap heuristic (sealed records above),
stall abort in standard live acceptance, `TMPDIR` redirection, pattern-based env scrubbing,
program-pointer scrubbing, proxy-exit attestation, `AGENTS.override.md` and admin-hook closure,
the host filesystem read boundary, prompt caching, new diagnostics dashboards, and regrading
historical cases.

## 7. Self-review record

Independent review: native `gpt-6-astra/high` worker through the local routing harness, per the
established acceptance procedure. Review loop status: **open** — this section records each round's
verdict and dispositions as the loop runs; the loop closes at ACCEPT or is escalated to the user.
