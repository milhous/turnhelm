# Worker Activity Evidence Design

Date: 2026-10-17. Code baseline: `499367d5f5a69f0dec04f4f849bdc5870edefc6c`.

> Status: the user requested an independent Astra subagent review, spec revision, and execution plan
> after reviewing the initial spec. Current authority covers that review and English documentation,
> local checks and documentation commits, not implementation, native worker/provider test calls,
> publication, or service/authentication/proxy changes. All previous campaign authorities are closed.
> The revised spec and plan return to the user before implementation. Optimize for long-term benefit,
> safety, and performance; do not maintain backward compatibility for the changed diagnostic vocabulary.

## 1. Problem and evidence boundary

The latest sealed campaign settled 104/104 scenarios: 99 passed, four failed, and one timed out
unjudged. Three calibration policy mismatches are separate. Its verdict remains
**COMPLETE-WITH-FAILURES**, not an incomplete roster. The input report is private local evidence:

- Root: `/Users/zhangxiao/.local/state/turnhelm/validation-20261017-499367d-tqNPWh`.
- Report: `final-report/REPORT.md`; machine report: `final-report/report.json`.
- Final seal: `2db83c4f24465ed11299298b0b43e69072a773aaee862ddd7350939a4620f49e`.
- Diagnostic annotations: `DIAGNOSTIC-NOTES.md` and `post-observation-diagnostics.json`.

| Observation | Established fact | Not established |
| --- | --- | --- |
| `feature-prose` | Completed worker incorrectly claimed read-only access prevented reading a fixture | An actual filesystem read denial or its cause |
| `11-url` | Completion JSON matched; implementation remained the initial placeholder | Why implementation was skipped; a causal schema or model effect |
| `30-incident`, `37-capacity` | Completed workers returned shape-valid but wrong values | Whether input was read, a command failed, or reasoning was wrong |
| `26-refunds` | Frozen 240000 ms deadline expired; eight decoded frames, last-event age 208644 ms; owned teardown | Deadlock, provider stall, approval wait, or credential failure |
| Decoder collapse | `decodeWorkerEvent` maps every non-agent `item.completed` to identical `tool-progress`, discarding item type/status/exit code; started/updated items are ignored | The internal cause of any of the five non-passes |

The collapse was reproduced offline using synthetic reasoning, command-execution, and file-change
frames, including a failed command with exit code 13. This identifies an **observation-loss boundary**,
not a task-delivery root cause. Existing sealed archives cannot recover discarded facts. All five
non-passes requested `gpt-6-luna/low`; passing fixed-balanced/schema-off controls are sequential single
observations, not causal proof that changing a tuple or removing a schema fixes them.

The native JSONL surface includes item lifecycle events and several item kinds, as described in the
[official non-interactive-mode documentation](https://learn.chatgpt.com/docs/non-interactive-mode).
This design treats native optional metadata defensively rather than assuming every version emits it.
The documented category surface is not a verified full schema for `item.updated`, every status, or
`exit_code`; the optional projection below must tolerate those facts being absent in real runs.

## 2. Decision and scope

**Enrich the existing opt-in lifecycle, then preserve that projection through both acceptance
harnesses on every outcome where attributable evidence exists.** Do not add an always-on counter API,
new trace flag, raw-event archive, dashboard, persistence service, or logging dependency.

| Alternative | Decision |
| --- | --- |
| Existing lifecycle with fixed-enum activity facts | Adopt: reuses the recorder, receipt, journal, and shared harness projection |
| Save raw JSONL, commands, outputs, paths, or reasoning text | Reject: sensitive content retention is unnecessary for this first diagnostic |
| Add a parallel activity summary/counter framework | Reject: duplicates the timeline and introduces another evidence contract |
| Raise every fast task to balanced, inflate deadlines, retry failures, or refit bands | Reject: changes outcomes before identifying their causes |

The product default remains lifecycle-disabled. Acceptance workers explicitly enable the existing
`--lifecycle` flag. Pure reasoning tasks may validly use no commands. Activity observations are never
task-correctness, routing-quality, liveness, billing, or safety gates.

Unchanged: task bytes delivered on stdin; native worker argv, sandbox, managed home and environment;
model/effort routing and fallback; output schema and final-message framing; terminal error precedence,
deadlines, cancellation and owned teardown; exactly-one-receipt behavior; all existing consumer gates,
stop order, exit codes, sealed artifacts, and grades. No new automatic escalation or request is added.

## 3. Normative evidence contract

### 3.1 Decode only bounded facts

Add an internal `WorkerEvent` variant with `kind: "activity"`. Reuse the already-recorded lifecycle
`kind: "event"` entry for each successfully decoded frame. Its activity detail has this exact shape:

```typescript
type ActivityDetail = Readonly<{
  eventKind: "activity";
  itemKind: "reasoning" | "command_execution" | "file_change" | "other";
  itemPhase: "started" | "updated" | "completed";
  itemStatus?: "in_progress" | "completed" | "failed";
  itemExitCode?: number;
}>;
```

The internal activity variant carries the same item fields without `eventKind`. Add these typed fields
to the existing lifecycle detail contract; do not add a second receipt-level activity object.

| Native input | Projection |
| --- | --- |
| `item.started`, `item.updated`, or `item.completed`, with a non-agent item and string `item.type` | Activity; phase comes only from the root event type |
| Exact item type `reasoning`, `command_execution`, or `file_change` | Corresponding fixed `itemKind` |
| Any other non-agent string item type, including MCP/web/plan kinds | `itemKind: "other"`; do not preserve the native type name |
| Exact `item.status` in the three-value whitelist | Optional `itemStatus`, copied without inferring success from phase |
| `item.exit_code` on a completed `command_execution` | Optional `itemExitCode` only when a number and `Number.isSafeInteger`; retain signed values and zero |
| Missing/null/invalid/out-of-range exit code, or exit code on another kind/phase | Omit `itemExitCode`; never coerce or zero-fill |
| Missing/null/unknown status | Omit `itemStatus`; never replace it with phase |
| Agent-message started/updated | Existing ignored-event behavior; retain no partial message text |
| Completed agent message | Existing message/text validation and final-message behavior |

For started/updated events with absent/malformed item metadata, retain existing ignored-event behavior;
do not introduce a new protocol failure. For completed items, retain existing required item/type checks
and malformed-agent-message failures. Invalid UTF-8/JSON, oversized frames, turn completion/failure,
native error classification, and unknown root events retain their current semantics. Native extra keys
are discarded at decode, not forwarded to lifecycle or evidence parsers.

Optional diagnostic metadata never creates worker failure or success. A completed command with
`itemStatus: "completed"` and `itemExitCode: 13` retains both observations; do not normalize the status.
A file-change status is a native report, not an independently verified filesystem diff. Reasoning is
not tool execution. A command failure does not establish that a fixture read was denied.

### 3.2 Reuse recording and diagnostic delivery

`executeWorker.processFrames` records exactly one existing `event` entry per successfully decoded
frame, now with sanitized activity detail when applicable. Do not record extra lifecycle entries for
the same frame. `progressEvents` and `lastEventAgeMs` retain their decoded-frame definitions, including
ignored frames; do not reinterpret them as tool counts or compare them with unique-action counts.

Replace the misleading fixed `tool-progress` stderr diagnostic with `worker-activity` for completed
non-agent items only. Started/updated activity produces no additional stderr diagnostic. Keep the
existing bounded, lossy diagnostic/backpressure handling. Do not retain a compatibility alias or emit
native item names, statuses, commands, outputs, or error text in diagnostic prose. Activity dispatch
must not affect last-agent-message selection, usage, failure precedence, or settlement.

Lifecycle remains opt-in. Its in-memory/receipt capacity remains 64 entries: first eight and last 56,
with truthful overflow and the final settle entry retained when settlement occurs. The existing
best-effort journal receives one append per recorded lifecycle event, not an extra activity stream.
The journal itself is not a 64-line store and is not newly rotated or made transactional here.

For example, these are two observations of a command lifecycle, not two command executions:

```json
[
  {"tMs":4,"kind":"event","detail":{"eventKind":"activity","itemKind":"command_execution","itemPhase":"started","itemStatus":"in_progress"}},
  {"tMs":9,"kind":"event","detail":{"eventKind":"activity","itemKind":"command_execution","itemPhase":"completed","itemStatus":"completed","itemExitCode":13}}
]
```

Do not add item IDs or per-item state to correlate phases. No unique-action count is claimed.

### 3.3 Shared projection and retention on all outcomes

Extend the existing exported `projectWorkerLifecycle` and its detail validation in
`test/live-acceptance.ts`; reuse that projection in `test/custom-round.ts`. Keep one whitelist, not a
custom-round copy. Extend strict evidence sanitization and journal reconstruction coherently.

- New item fields are legal only on `kind: "event"` with `eventKind: "activity"`; `itemKind` and
  `itemPhase` must be present and exact enums. `itemExitCode` is legal only for completed commands.
  Activity detail may contain only the five declared keys; mixing in process/settlement detail fields is
  an inconsistent combination, not a second interpretation of those fields.
- Missing optional fields remain absent. Invalid detail values or inconsistent field combinations
  drop the entire detail, preserving the valid event envelope, as the current projector does for
  malformed values. Unknown keys in a purported projected detail continue to reject evidence; do not
  relax the existing fail-closed ledger boundary. No arbitrary string passes through a known key.
  Check the complete key set before validating values so rejection cannot depend on insertion order.
- Preserve valid existing non-activity lifecycle detail fields and their current validation. Do not
  overload process `exitCode` or settlement `status` with native item facts.
- Apply the same first-eight/last-56 retention to oversized projected timelines and reconstructed
  journals. Preserve an incoming `overflow: true`; set it when truncating. Re-projecting valid evidence
  must be idempotent. Reuse the existing capacity/retention definition rather than a divergent policy.
- Journal fallback enforces the existing intended 1 MiB ceiling using the existing descriptor-backed
  `readProjectFile(root, ".turnhelm/lifecycle.jsonl", 1048576)` reader, not `stat` followed by
  `readFile`. This bounds actual reads and refuses final-leaf symlink/non-regular substitution without
  blocking on a FIFO. Reuse strict UTF-8 decoding, then the shared detail validation. Catch read,
  decode, JSON and projection errors at this best-effort boundary and return absent evidence.
- Filter journal events to the supervised CLI pid and order by monotonic `tMs`. Equal rounded
  timestamps do not establish exact native-event order; asynchronous append order is not a causal
  trace. Apply first-eight/last-56 to that approximate ordering, but guarantee settle retention only
  for the recorder/ordered receipt, not journal reconstruction. Missing, oversized, or malformed
  journals yield no fabricated timeline. Do not add sequence IDs, tie-breaking state or flush barriers.

Separate strict validation from extraction policy: raw receipt lifecycle extraction in both harnesses
catches projection rejection and omits the optional timeline rather than escaping the existing stop
record/priority. The strict evidence-ledger sanitizer still rejects unknown projected keys. Invalid
diagnostics do not become a new worker/case failure or bypass cleanup, output-cap, receipt or class
stops. A worker with `status: "not-started"` has no activity timeline or journal fallback.

Standard acceptance already launches worker cases with `--lifecycle`, but retains lifecycle only for
worker failure or timeout. Remove that outcome filter: retain projectable lifecycle on successful
controls, completed wrong answers, failed/cancelled workers, and timeout observations. Calibration
cases without workers still have no worker timeline. Preserve existing receipt-attribution rules.
In particular, standard acceptance's existing receiptless-timeout journal crash evidence remains
available; do not import custom-round's exactly-one-receipt restriction into that different path.

Custom-round currently launches without `--lifecycle`. Enable it for both argument and stdin-file task
transports, without changing task bytes, write/schema flags, or roster/config schemas. Add a top-level
optional `workerLifecycle` alongside its existing `workerFailure` projection, rather than renaming or
restructuring that existing field. Retain it for every case outcome (`pass`, `failed`, `timeout`) and
the existing projectable post-CLI stops (`cleanup-unverified`, `output-cap`, stopping worker classes,
`tree-drift`, `root-identity`, and the post-CLI pre-/post-contract `oracle-identity` stops that already
carry `workerFailure`). Projection is independent of the worker's terminal status.

Custom-round attribution still requires exactly one receipt and a projectable worker object; its
`receipt` stop carries no worker projection and must not be salvaged with journal data. Prefer a valid
receipt lifecycle. Early stop records use receipt evidence only; do not perform fallback I/O ahead
of the cleanup, output-cap, receipt and stopping-class gates. On the normal case path after
those gates, if lifecycle is absent/unprojectable after clean CLI closure with one attributable
executed-worker receipt, reuse the shared pid-filtered journal reader as best-effort fallback. Later
projectable stop records may reuse that already-collected projection, without stop-specific I/O.
Pre-spend stops and the current signal/contract-infrastructure stop paths do not gain new evidence
collection. No diagnostic addition may move or bypass a stop/settled-tree gate,
cause more spend, or grade a timeout. Ledger append failures retain existing stop behavior.

Custom-round's current tree comparison exempts only `.turnhelm/routes.jsonl`; merely enabling lifecycle
would otherwise create a false tree-drift failure. Exclude the exact CLI-owned
`.turnhelm/lifecycle.jsonl` regular-file leaf consistently from its tree snapshots, before applying the
ordinary file-size/read budget. This adopts standard acceptance's exact-file exclusion while retaining
custom-round's non-regular-leaf rejection. Test this exact path before directory recursion: an empty
directory is not a journal. Do not exclude the whole `.turnhelm` directory or alter declared
business-file allowances. Still reject a symlink, FIFO, directory or other non-regular leaf at that path
without reading it. An oversized regular lifecycle journal makes fallback evidence unavailable, not
the consumer tree invalid. This diagnostic-file exemption is not
an integrity attestation of journal contents; their projection remains untrusted and whitelisted.

### 3.4 Privacy, performance, and interpretation

Only fixed enums and validated bounded numeric scalars cross the new boundary. Never retain new raw
commands, command output, file paths/diffs, item IDs, reasoning text, MCP arguments/results, native
error prose, prompts, credentials, arbitrary native type names, or hashes of those new content fields.
Existing task/error hashes and existing final-output/oracle retention are unchanged; this is not a
claim that all pre-existing artifacts are content-free or that final output is redacted.

Per decoded frame, work is constant-size validation and projection with no new I/O operation. Product
lifecycle-disabled runs gain no journal writes. Standard acceptance adds no writes per event; enabling
custom-round lifecycle intentionally adds the existing lifecycle journal cost. The recorder remains
bounded; journal read caps and the supervisor's existing output caps remain unchanged. No per-item map,
unbounded buffer, synchronous content scan, new dependency, network operation, or background worker.

Absent lifecycle, missing fields, discarded detail, or overflow means unknown/incomplete evidence,
not zero activity. Even a non-overflowed timeline describes only frames decoded by the parent, not
all provider/OS activity. Observed command/file events establish native-reported activity, not that
the intended input was read or the requested implementation was written. Without sensitive content
capture, this design cannot identify which file a command accessed; that limitation is intentional.

## 4. Connected implementation surface

This is a future implementation boundary, not implementation authorization. Current work changes
only this spec and its companion plan. The later change must cover all connected consumers in one contract:

| Surface | Required responsibility |
| --- | --- |
| `src/codex-events.ts` | Typed activity projection and defensive optional-metadata handling |
| `src/codex.ts` | Record enriched existing events; activity dispatch and fixed diagnostic rename |
| `src/lifecycle.ts` | Typed detail and reusable existing retention definition, no capacity change |
| `src/cli.ts`, `src/journal.ts` | Verify receipt/journal forwarding preserves only sanitized facts; keep current ownership, append and opt-in behavior |
| `test/live-acceptance.ts` | Shared whitelist/projection, safe best-effort journal reconstruction, extraction fault containment and all-outcome retention |
| `src/project.ts`, `test/project.test.ts` | Reuse and verify existing bounded non-following reader; no new I/O abstraction or reader rewrite |
| `test/custom-round.ts` | Both task transports enable lifecycle; exact regular-journal tree exemption; shared projection on cases/projectable stops |
| `test/codex-events.test.ts`, `test/worker.test.ts`, `test/lifecycle.test.ts` | Decoder, dispatch/backpressure, lifecycle CLI and retention regressions |
| `test/codex.test.ts` | Verify the existing worker-module export contract; no new runtime export is needed in this module |
| `test/cli.test.ts`, `test/route-journal.test.ts` | Exact receipt/journal propagation and shared safe-append/opt-in/privacy regressions |
| `test/live-acceptance.test.ts`, `test/custom-round.test.ts` | Strict projections, fallback, every outcome and unchanged stop/grade semantics |
| `README.md`, `.agents/skills/turnhelm-routing/SKILL.md` | Current diagnostic vocabulary, activity limits and all-outcome evidence; keep shared passages aligned |
| `test/package.test.ts`, `test/init.test.ts` | Verify packaged/installed documentation contracts; update only assertions genuinely changed by this design |

Use synthetic fixtures inside existing test helpers. No roster fixture, default config, package/export
surface, classifier policy, approval manifest, or sealed report needs a new schema or compatibility
adapter. Update any exact-key/text assertions reached by the contract; do not weaken security or
coverage gates to make them pass. Avoid unrelated cleanup.

## 5. Acceptance criteria for later implementation

All criteria below are offline. Fake native workers and local fake classifiers must make no real
provider request. Passing them establishes the evidence mechanism, not task-delivery reliability.

1. **Decoder matrix:** all three phases and four item-kind classes, agent-message behavior, unknown
   item/root types, missing/malformed metadata, explicit failed status, nonzero/zero/signed safe exit
   codes, null/string/fraction/unsafe codes, and conflicting status/code observations. Existing strict
   framing and terminal-failure tests remain passing.
2. **Privacy canaries:** put distinct secret-like strings in native command, output, reasoning, path,
   item ID, unknown type/status and nested MCP fields. None reaches the decoded activity projection,
   fixed diagnostics, lifecycle receipt, lifecycle journal, or either harness's worker evidence.
   Preserve existing final agent-output/oracle semantics rather than claiming to redact them.
3. **Delivery and settlement:** fake-worker regressions retain exact task stdin, all six requested
   tuple argv, managed-home behavior, schema-on/off framing, exactly one receipt, bounded diagnostics
   under stderr backpressure, sticky failure, cancellation and owned teardown. Activity metadata,
   item failure status and nonzero item exit codes never determine CLI status or stdout: they
   are observations only. Existing diagnostic sink-error/output-failure behavior remains unchanged.
   Lifecycle-disabled runs retain no lifecycle/journal.
4. **Flood and retention:** more than 64 mixed events preserve first eight/last 56 and settle when
   present in the recorder/ordered receipt, with overflow true and no per-item memory growth. Receipt
   projection, re-projection and pid-filtered journal reconstruction obey the same bound, without a
   journal settle/order guarantee on tied timestamps. The maximally populated 64-entry receipt stays
   below the supervisor's 65536-byte line cap. One decoded frame produces one lifecycle
   event append, not two; progress counts remain decoded-frame counts.
5. **Projection boundary:** valid new facts survive both harnesses and journal fallback; malformed
   detail drops, unknown projected keys reject, arbitrary strings never survive. Missing metadata
   stays absent. Oversized/missing/malformed journals and another pid's events never fabricate evidence.
   Unknown detail keys reject in either insertion order, including alongside invalid known values.
   Raw receipt/journal extraction catches those rejections; direct strict ledger input still rejects.
   Verify strict UTF-8, growing/replaced leaf, symlink/FIFO/directory and exact read-cap boundaries
   through the existing reader and integration helpers; no fallback I/O occurs before stop gates.
   Custom-round permits the exact regular lifecycle journal without tree drift, including an oversized
   journal, but still rejects symlink/FIFO/directory leaves and changes elsewhere in `.turnhelm`.
6. **All outcomes:** standard and custom harness tests retain evidence for a correct completed
   control, completed wrong output, completed-but-unchanged implementation, failed worker, cancelled
   worker and clean one-receipt timeout. Custom tests cover both task transports and all listed
   post-CLI stops, plus receipt-count/pre-spend/signal/contract-infrastructure and not-started paths
   that must not gain a projection. No change
   to failure classes, timeout being unjudged, integrity-stop priority or completed/count reconciliation.
7. **Regression commands:** run build/typecheck, the focused tests above, full `pnpm test`, and stock
   `pnpm test:coverage` with existing 80% gates. Run dependency audit and `git diff --check`; inspect the
   scoped diff and README/skill alignment. No live command belongs to this verification stage.

## 6. Next decision boundary and non-goals

The user explicitly requested this review/revision and an implementation plan. The companion
[execution plan](../plans/2026-10-17-worker-activity-evidence.md) remains subject to user review and an
execution-method decision. Implement and verify offline only after that decision, and before preparing
any new live diagnostic. Do not silently extend documentation authority into implementation or testing
against real providers.

A later paid diagnostic must have a fresh finite manifest/SHA approval, explicit cases and caps,
predeclared acceptance/stop rules, frozen inputs and matched controls. It must state which uncertainty
the new timeline can distinguish. Change one experimental variable at a time, report actual selected
tuples separately from forced mappings, and retain non-reproductions and ambiguous outcomes. The
timeline may narrow hypotheses but cannot by itself prove a file-read cause or a model-tier effect.
Do not replay the old 104-case campaign or reuse its unused request caps.

Excluded: routing-policy repair, universal success or optimality claims, filling natural xhigh/max
coverage, real API billing/invoices, proxy-exit attestation, host-secret isolation, instruction-policy
changes, approval-policy pinning, provider-internal tracing, raw capture, retries, adaptive escalation,
deadline changes, dashboards, and regrading historical cases. These remain separate decisions.

## 7. Self-review record

Independent review: native `gpt-6-astra/high` subagent `astra_activity_spec_review`, isolated review-only
context, reviewed original commit `e121891`. Verdict: **PROBLEMS - narrowly correctable**. The reviewer
found the existing-lifecycle architecture appropriately small and rejected a parallel tracing system.
The parent verified and incorporated the findings below; there was no second independent review of
the revision and no native worker/provider test request.

| Review finding | Verified source at code baseline | Disposition |
| --- | --- | --- |
| Pre-read stat is not an actual read ceiling; substituted leaf can block/follow | `test/live-acceptance.ts:1203-1205`, `src/project.ts:32-56` | Reuse existing descriptor-backed bounded reader, with its existing parent-path/final-leaf limits; no new I/O framework |
| Strict projection exceptions conflict with best-effort fallback and stop precedence | `test/live-acceptance.ts:1135-1136,1221`, `test/custom-round.ts:1167-1195` | Catch at raw extraction/fallback boundaries; strict ledger rejection unchanged |
| Unknown-key rejection depends on field order | `test/live-acceptance.ts:1134-1156` | Prevalidate the key set, test both orders |
| Test surface and two existing stop branches omitted | `test/worker.test.ts:131,2501`, `test/custom-round.ts:1247-1252,1270-1275` | Add actual worker helpers and post-CLI oracle-identity evidence |
| Sink-error and reconstructed-settle promises too broad | `test/worker.test.ts:1634-1658`, `test/live-acceptance.ts:1225-1229` | Preserve sink failures; qualify approximate journal chronology instead of adding sequence machinery |
| Directory-at-journal, not-started and native-schema confidence need explicit treatment | `test/custom-round.ts:334-337,880-895`, official protocol documentation above | Add boundary tests/guards and state optional-schema uncertainty |

The parent also added a maximum-expanded-receipt line-cap check. Decoder combinations belong in fast
table tests; integration fixtures prove propagation and stop categories without a Cartesian matrix.
This review narrows the design; it does not establish a task-failure cause or change a historical grade.

Document checks cover structure, English prose, examples, source/test references, companion links,
sealed-report totals, scoped diff and dependency audit. Runtime suites and live diagnostics are not
rerun merely to validate these documentation changes; implementation verification belongs to the plan.
