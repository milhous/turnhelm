# Live-Acceptance Evidence and Continuation Hardening Spec

Date: 2026-10-12. Code baseline: `caad4d923636a4de66e22a1c104616e82c392b17`. Input: the 2026-10-12 dynamic-routing validation report (`/private/tmp/turnhelm-routing-validation-20261012-Hsr8zj/REPORT.txt`, approval SHA-256 `2626a708…41be86a`), verdict PARTIAL.

> Status: drafted under the user's authorization to write this spec, have it re-checked by codex (`gpt-6-astra`), update it from that review, and write an execution plan. That authorization does not extend to code implementation, paid calls, or publication.

## 1. Findings and decision boundary

Round facts: 13/13 workers completed, 36/2 engineering checks passed, 27/5 policy band matches, suites `laya` failed at case 4 of 7, `jev` not executed, `dual` failed on routing, `calibration-dev` complete with 9/3 (exit 3), `calibration-holdout` 12/12 (exit 0). Wherever the chain was graded it behaved correctly (model/effort selection, fail-closed Jev, preserved exit codes), but the round leaves **one unresolved task-output failure whose cause the missing evidence cannot settle** (arithmetic, formatting, or encoding — `REPORT.txt:29`) and **one external provider blocker** (`REPORT.txt:30`). Neither licenses a production change, and neither is hereby declared product-clean. Therefore this spec changes the acceptance harness only; `src/` is untouched, and both historical findings stay open (§6).

| Report finding | Disposition |
| --- | --- |
| `stdout-oracle-failure`: correct route, CLI exit 0, worker completed, every preservation check true, strict stdout-json oracle false; raw stdout not retained, arithmetic vs formatting unproven | §3 — retain the oracle's bounded input as frozen evidence |
| `fresh-coverage-gaps`: the laya suite stopped permanently at its failing 4th case; `admission-gpt-6-astra-xhigh`, `admission-gpt-6-astra-max`, `default-natural` never ran and cannot be resumed | §4 — continue the roster on task-output failures |
| `predeclared-band-mismatches`: dev heading-en selected frontier 3×; business race→balanced, migration→fast; both business contracts passed | No code. Policy facts under the frozen calibration design; no band/prompt tuning |
| `hosted-jev-blocked`: controlled Laya 503 → hosted Jev HTTP 451, 707 ms, no worker | No code. External provider blocker; fail-closed behavior is correct and stays |

**Decision reversals against the 2026-10-11 routing-reliability spec**, each justified by what this round exposed:

1. §3 of that spec: "仍不保存 raw 输出" (no raw output persisted). One unexplained oracle failure was therefore undiagnosable — the single most expensive property of the round. Superseded, narrowly: the oracle's own bounded input is now retained (§3 below). Classifier raw responses, worker stderr, and transcripts stay unpersisted.
2. §5.3: worker-suite oracle failure stops immediately. One oracle failure destroyed 3 of 7 already-approved observations (43% of the round's admission coverage) with no replay path. Superseded: task-output failures continue the roster (§4). Chain-integrity failures still stop immediately.
3. §5.1: worker suites append no `completed` record. Without it, "complete with failures" and "stopped early" are indistinguishable from the exit code alone once continuation exists. Superseded: all suites append `completed` (§4).

| Approach | Long-term benefit / safety / performance | Decision |
| --- | --- | --- |
| A: bounded oracle-input retention + oracle-only continuation + unified completed record; harness/test/docs only | Every judged worker-oracle failure diagnosable from frozen evidence without replay; approved coverage survives isolated task failures; zero production-path change | **Adopt** |
| B: keep fail-fast, accept the coverage loss, add ad-hoc stdout capture outside the harness | Repeats this round's outcome on the next failure; evidence depends on session-side retention (the exact asymmetry that bit this round: business retained, admission not) | Reject |
| C: resume/replay of claimed runs, report/analytics framework, full transcript capture, new suites | Expands authority surface and maintenance against unproven needs; resume breaks the one-claim safety property | Reject |

Not maintaining backward compatibility means replacing tests that pin the old stop semantics and the worker-suite-no-completed shape. It does not mean lowering safety thresholds, rewriting historical reports, or re-grading sealed rounds.

## 2. Scope, inheritance, and invariants

Files changed: `test/live-acceptance.ts`, `test/live-acceptance.test.ts`, the live-acceptance section of `README.md`, and the live paragraph of the shared skill source `.agents/skills/turnhelm-routing/SKILL.md` (single source; the existing `.claude/skills/turnhelm-routing` symlink keeps pointing at it, YAML metadata untouched). `test/live.integration.ts` only if its compile surface moves. Not changed: anything under `src/`, `package.json`, the corpus fixture, manifest/corpus schemas (both stay v2 — future manifests pick up the new source hashes through the existing baseline freeze), dependencies.

Inherited unchanged from the 2026-10-10/11 specs: private owned run root, human-approved manifest SHA, strict parsers, frozen source/dist/corpus/task/config/input/tool verification, one-time O_EXCL claim, **never replayed or resumed**, reservation durable before spend, observed-before-verdict ordering, evidence-write failure stops the run, per-suite caps, at most one attempt per eligible backend, Jev triple gate, cancellation 130/143, exit 2 usage errors.

New exit code **4**: a fully completed worker-suite roster with one or more engineering failures — the structural mirror of calibration's exit 3 (complete roster, policy mismatch). Existing codes keep their meanings: 0 complete pass, 1 stopped/incomplete/failure before completion, 2 usage, 3 calibration policy mismatch, 130/143 signals.

## 3. Bounded oracle-input retention (VH-1)

The `verified` evidence record of every worker case **whose oracle actually ran** gains one field, `oracleInput` — exactly the input the oracle judged, and nothing else:

```ts
type OracleInputEvidence = Readonly<{
  source: "stdout" | "summary-file";
  text: string | null;   // null: undecodable (bytes set) or unavailable (bytes null)
  bytes: number | null;  // retained byte length; null when the payload could not be read
}>;
```

No truncation flag exists because retained oracle input is structurally whole: a stdout cap breach halts the run as `output-limit` before any `verified` record exists, and the summary-file oracle reads one bounded whole-file read.

- **Scope is judged cases only.** Operational stops (`cleanup-unverified`, `output-limit`, `timeout`, `signal`) never reach a `verified` record and keep their existing records — the stop is its own diagnosis; no retention is promised there. A summary read that is refused (unsafe, non-regular, oversize) already fails as `verifiable: false` and stays an integrity stop; it never becomes a continuable oracle failure.
- `source: "stdout"`: the existing `supervision.stdout` buffer, already capped at `STDOUT_CAP_BYTES` (64 KiB) — a cap breach halts the run before any `verified` record, so the retained buffer is whole. `bytes` = retained buffer length; `text` = `decodeBounded(...)` result, `null` when not valid UTF-8 (the byte count alone identifies decoding failure without storing invalid bytes). Through the well-formed production CLI this branch cannot carry invalid UTF-8 (worker event frames are validated before their text reaches stdout); the null-text shape is exercised end-to-end through the summary-file source.
- `source: "summary-file"`: the existing capped `readProjectFile(item.root, "out/summary.json", 65536)` read. An absent file gives `text: null, bytes: null`.
- `classifier-only` cases carry no `oracleInput`.
- `sanitizeEvidence` whitelists exactly these three keys and types and rejects `text` whose UTF-8 byte length exceeds 65 536 (a byte bound, so multibyte content cannot slip past a character count); no other raw content passes through. Retained on pass and fail alike — pass-case retention is what makes oracle spot-checks possible.
- Adjudication power: for judged cases, arithmetic error vs formatting (prose, fences, extra keys) vs encoding failure vs absent payload becomes decidable from the frozen evidence file alone, with no paid replay. That is the entire fix for the report's "cause is unproven" gap; the oracle itself (`jsonEquals`) is unchanged and stays strict.
- **Size honesty:** the bound is 64 KiB of payload *before* serialization. `JSON.stringify` escaping can expand control characters ~6× (`\u0000`), so a worst-case worker record is ~384 KiB serialized and a full round a few MiB — bounded, private, no global log-budget mechanism. The evidence stays inside the claimed run's private evidence JSONL; no new file, no path outside the run root.
- **Privacy honesty:** this is deliberate **raw-content retention**, not secret sanitization. Agent-message text is arbitrary (`src/codex-events.ts` accepts any string; `src/codex.ts` writes it through) and the worker environment filter strips only named keys, so stdout may in principle contain sensitive text; the four-key whitelist bounds shape, not content. The manifest approval therefore covers the evidence file's content too. No redaction framework is built. A hostile-string serialization test must prove that arbitrary stdout content keeps the evidence JSONL one valid JSON record per line (`JSON.stringify` containment — record injection is not possible, and the test pins it).

## 4. Engineering-failure split and roster continuation (VH-2)

Failed checks now split into two classes with an exact rule:

- **Chain-integrity failure — stop immediately** (`stopped` reason `verdict`, exit 1): any of `receipt-unique`, `receipt-selected`, `receipt-pair`, `receipt-task`, `receipt-root`, **`root-identity`**, `exit-zero`, `worker-completed`, `input-unchanged`, `config-unchanged`, `git-clean`, `attempts-made`, `laya-first`, `verifiable` false, or any classifier-only check (`route-selected`, `profile-legal`, `backend-eligible`, `attempts-made`) false. These prove the product or harness contract broken; further spend is not justified. `root-identity` is **newly graded**: the root dev/ino comparison against the manifest-frozen identity is computed today and recorded in `observed` (`rootMatches`) but never graded — `verifyCaseFrozen` re-checks it only *before* each reservation, so a mid-case identity replacement currently rides an otherwise-true check set. Grading it closes the one continuation hole where spend could continue behind a replaced root.
- **Task-output failure — record and continue**: the `oracle` check false while every other check is true. The routing chain is proven intact; the worker's output failed the oracle (no claim about arithmetic vs formatting until §3 evidence exists). The `verified(fail)` record (with §3 evidence) is appended, no `stopped` record is written, and the roster proceeds. If `oracle` is false together with any integrity check, the integrity failure dominates and the run stops.

Continuation spends only reservations already inside the approved manifest — the same envelope the operator signed, the same precedent as calibration band-mismatch continuation. Caps, claim-once, and never-resume are untouched; this changes no authority boundary, only whether already-approved observations are discarded after an isolated task failure.

**Completed record for every suite.** After the last `verified` record:

- Worker suites append `{phase:"completed", outcome:"pass"|"fail", cases, failed}` — strict shape, unknown fields rejected. All counts are non-negative safe integers (the existing `completed` discipline). `cases` **equals the claimed manifest's roster length** — worker manifests may be legal subsets, so no fixed twelve is imposed; `failed` equals the number of this run's `verified` records with verdict `fail` (exact reconciliation; `failed ≤ cases` is the sanitizer's check, the runner guarantees equality at append time); `outcome === "fail"` iff `failed > 0`.
- Calibration suites keep the existing five-field shape and its twelve-case constraints.

The §5.1 commit protocol unifies: every suite appends `completed`, re-verifies frozen corpus/source/dist and the host snapshot, closes the evidence FD, takes the final abort check, and only then returns 0 / 3 / 4. `completed` plus the exit code is a **convenience status only**: acceptance reading still reconciles unique case IDs, per-case verdicts, the counts, the absence of a terminal `stopped`, and the actual process exit — the prior spec's §5.1 reader contract, now uniform across suites. A visible `completed` line alone proves nothing. Stopped runs keep exit 1; readers distinguish "complete with failures" (completed + exit 4) from "stopped early" (stopped + exit 1) at a glance, then reconcile per-case records before signing anything.

## 5. Worker usage on the observed record (VH-3)

Worker cases' `observed` record gains `workerUsage`: the receipt's usage snapshot projected to the four whitelisted counters (`input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_output_tokens`; safe non-negative integers only — unknown or malformed counters are dropped by the projection, never rejected as an error) — partial snapshots keep only the counters present, never zero-filled. The receipt emits the literal string `"unreported"` when the worker reports no usage (`src/cli.ts`); absent usage, that literal, and a usage object with no valid counter all project to `"unreported"`. The report itself flags the missing standard-harness usage retention (`REPORT.txt:42`), so future cost/quality analysis reads frozen evidence instead of session-side retention, closing the asymmetry this round exposed (business receipts kept, admission receipts not). No aggregation, no billing math, no new fields beyond the projection; usage scope remains **unverified** — this is not billing or savings evidence.

## 6. Findings deliberately kept open (no code)

- **Hosted Jev HTTP 451**: external. No retry, bypass, endpoint guessing, or gate change. Closes only on provider-side evidence plus a newly authorized Jev-only/fallback round (work-state item `hosted-jev-http451-dependency`).
- **Band mismatches**: predeclared-policy facts. No prompt, band, or profile tuning; comparative quality/time/usage claims flow only through the frozen calibration design's separately gated worker round.
- **Six-profile natural coverage**: admission rebinding proves access, not natural selection. The uncovered cases (`frontier_xhigh`/`frontier_max` admission, `default-natural`, natural deep/heavy selections) need a future frozen corpus/scope with fresh approval; unused caps never carry over; no profile forcing.
- **The 2026-10-12 astra-high oracle failure itself**: not re-run, not re-graded, not assumed fixed. §3 makes the *class* diagnosable; the specific case stays unresolved until a future authorized round reproduces it with retention in place.

Explicit non-goals: resume/replay of claimed runs; report/analytics framework; new suites or corpus edits; production routing changes; billing or budget platform; keyword rules; retry logic anywhere.

## 7. Acceptance criteria

| ID | Required evidence |
| --- | --- |
| EC-01 | `oracleInput` retained for every judged worker case, pass and fail, both oracle kinds; sanitizer rejects unknown/malformed shapes and text above the 65 536-byte bound (tested with multibyte text whose character count is below the bound); classifier-only records carry none; operational-stop cases carry no `verified` record at all; a refused oracle read keeps `verifiable: false` with no `oracleInput`; hostile-string test proves arbitrary stdout keeps the evidence JSONL one valid JSON record per line |
| EC-02 | Oracle-only failure continues the roster and later cases are graded; any integrity failure (or oracle-plus-integrity) stops immediately with reason `verdict`, exit 1; a focused regression proves a mid-case root-identity replacement dominates an oracle failure and blocks the next reservation; classifier-only engineering failure still stops |
| EC-03 | Worker suites append the strict `completed` shape with safe-integer counts, `cases` equal to the claimed roster length (legal subsets included), and `failed` exactly reconciling the run's fail verdicts (multi-failure rosters included); complete-with-failures exits 4; a terminal evidence-I/O or signal failure after the completed append still exits 1/130, never 4; exit 0 only through the full commit protocol; stopped/incomplete still exits 1; calibration 0/3 semantics unchanged |
| EC-04 | `observed.workerUsage` is the whitelisted four-counter projection (partial snapshots kept, never zero-filled; malformed counters dropped, not thrown) or `"unreported"` (absent usage, the emitted literal, or zero valid counters); nothing else passes the sanitizer |
| EC-05 | One-claim/never-resume, caps, frozen re-verification, reservation ordering, evidence-I/O stop, signal 130/143, and output-limit regressions all still green |
| EC-06 | README and shared skill live paragraph state the new exit codes, continuation policy, and retention bounds consistently; symlink distribution unchanged; full offline suite green with line/branch/function coverage ≥ 80; zero diff under `src/` |
| EC-07 | Documentation honesty: nothing claims the 2026-10-12 failures are resolved or product-clean; §6 findings stay open |

## 8. Astra review record

Independent reviewer: codex `gpt-6-astra` (default effort), fresh read-only session `01a12e0b-aedd-7eb0-8b95-db566b7ba27e`, 2026-10-12, 8m23s; reviewed the draft against baseline `caad4d9`, the harness source, the prior spec, and both reports. Verdict on the draft: **PROBLEMS** (1×P1, 5×P2). All six findings accepted; none rejected. Dispositions:

| Finding | Disposition |
| --- | --- |
| P1: `rootMatches` is observed but never graded; a mid-case root replacement could ride oracle continuation (`verifyCaseFrozen` re-checks identity only before each reservation) | Accepted; §4 newly grades `root-identity` as chain-integrity, with a focused replacement-dominance regression (EC-02) |
| P2: §3 implied synthetic tasks make stdout secret-free; key whitelisting bounds shape, not content | Accepted; §3 now states deliberate raw-content retention under the manifest approval, no redaction claimed or built; hostile-string serialization test added (EC-01) |
| P2: "every worker case" retention and `truncated = outputOverflow` were wrong — operational stops bypass `verified`, the flag spans both streams, refused summary reads already stop as `verifiable:false` | Accepted; §3 scope narrowed to judged cases; `superviseCli` gains a stdout-specific overflow bit; refused reads stay integrity stops |
| P2: the "< 1 MiB per round" claim is false after JSON escaping (~6× control-character expansion) | Accepted; §3 states the 64 KiB pre-serialization bound plus worst-case expansion; byte-based sanitizer bound; claim removed |
| P2: `completed` validation was weaker than the prior reader contract (no safe-integer/subset/reconciliation rules; completed+exit alone must not replace per-case reconciliation) | Accepted; §4 adds safe-integer counts, `cases` = claimed roster length (legal subsets), exact `failed` reconciliation, and the uniform §5.1 reader contract |
| P2: §1 over-diagnosed both failures as harness problems; the report leaves the oracle cause unresolved and the dual failure is an external blocker | Accepted; §1/§4 reworded to "one unresolved task-output failure, one external provider blocker, no evidence for production changes"; findings stay open |

Reviewer's explicit answers: the three reversals are sound in direction; the check split is correct except the root-identity hole; retention suffices to adjudicate arithmetic vs formatting on judged inputs; exit 4 is useful and distinguishable; VH-3 is justified (`REPORT.txt:42`), not scope creep; nothing in the report demands production redesign, and the universal-diagnosability / secret-free / sub-1-MiB / proven-non-defect claims were the right things to cut. Residual risk (reviewer, retained): runtime behavior unchecked — the new privacy and continuation boundaries stay unverified until the tests land; counterexamples were static hypotheses, not reproduced failures. The reviewer made no edits and ran no tests, services, network, or model calls.

### Round 2 — revised spec + execution plan (2026-10-12)

Second fresh read-only review of the revised spec (content SHA-256 `37aecbf6…`) together with the first execution plan (content SHA-256 `bddd5a45…`), same reviewer model, ~10 min. Verdict: **PROBLEMS** (0×P1, 6×P2, 1×P3); all seven accepted, none rejected. Dispositions:

| Finding | Disposition |
| --- | --- |
| P2: the plan's verdict-block instruction was ambiguous — `rootMatches` scope, a second `verified` append on top of the common one, "otherwise stop" swallowing passing cases | Plan rewritten: `root-identity` joins the existing worker `checks` literal; `failedCases` is declared with the policy counters before the loop; exactly one common `verified` append; pass → proceed, oracle-only fail → count and proceed, any integrity fail → stop; both terminal checkpoints kept |
| P2: `workerUsage` extraction was anchored after the `observed` append (and "rejects unknown keys" contradicted the projection contract) | Extraction moves to immediately after `receiptFrame` (reused for the `worker-completed` check); projection drops malformed counters; the emitted literal `"unreported"` is tested |
| P2: the invalid-UTF-8 fixture poisoned Codex event frames (production rejects them pre-stdout); byte bound untested for multibyte; refused reads not pinned | Fixture retargeted to the summary-file boundary; multibyte above/exact-at the 65 536-byte bound; malformed-field table through `appendEvidence`; refused-read regression extended to assert no fabricated `oracleInput` |
| P2: test (d) mispredicted as RED (current fail-fast already stops it) | (c)(d)(g) reclassified as preservation pins; (e) sharpened to a root swap with a passing oracle — RED through behavior, and it asserts `root-identity: false` |
| P2: EC-03 lacked multi-failure reconciliation, terminal-fault-overrides-4, and the reader-contract doc paragraph | Subset-roster test carries two oracle failures; completed-append I/O and late-abort faults exercised on a would-be-4 run; the worker close-failure pin updated (completed now precedes close); Task-5 docs add the reconciliation contract |
| P2: a universal-diagnosability headline survived round 1's narrowing | §1 table and the plan Goal now promise diagnosis of judged worker-oracle failures only |
| P3: `oracleInput.truncated` is structurally unreachable (a stdout cap breach stops before any `verified` record), so the field and the planned `superviseCli` stdout-overflow bit are dead code | Adopted as a deletion: the field and the overflow-bit task are cut; §3 now records why no truncation flag exists |

The reviewer's residual-risk note stands unchanged: static findings only; runtime behavior unverified until the plan's tests land. No file edits, tests, services, network, or model calls were made by the reviewer.
