# Structured Payload Follow-up — Execution Plan

Date: 2026-10-13. Branch: `feat/structured-payload-followup`. Spec: `docs/superpowers/specs/2026-10-13-structured-payload-followup-design.md` (post-astra revision; all ten review findings dispositioned in its §8). Baseline: `fcbd56e`.

Authorization boundary: this plan covers offline implementation and tests only. No paid calls, no live suites, no sealed-artifact edits, no publication; merge/push stays with the user. Everything runs hermetically — no sandbox, probe, or macOS gating is involved.

Scope: PE-1 only — the structured payload contract (§3 of the spec) plus its observability projection (PE-07) and docs (PE-08). The provider-refusal stop policy, calibration, and all §6 items are out of scope; the roster-authoring rule (spec §5 / FR-02) is already recorded in both documents and needs no code.

Method: sequential inline TDD per the established repo method — red test → verify it fails for the stated reason → implement → green → commit per task, conventional commits. Coverage gate stays 80/80/80 on `dist/src/**`.

## Task 1 — Move the envelope discipline into the product (`src/payload.ts`)

Files: new `src/payload.ts`; `test/live-acceptance.ts` (import sites); new `test/payload.test.ts`.

- Red: `test/payload.test.ts` imports `envelopePayload`/`inertTrailerLine` from `../src/payload.js` and runs the 120-case no-regression matrix (the 2026-10-12 matrix, carried over: whole-JSON, first-line-JSON + inert trailers, non-inert trailers, fence lines, parseable trailer lines, empty, whitespace-only, BOM-free, multi-line pretty-printed JSON that is not one line). Fails: module does not exist.
- Implement: move `envelopePayload` and `inertTrailerLine` verbatim from `test/live-acceptance.ts:1395-1414` into `src/payload.ts` (product-owned, frozen definitions). `test/live-acceptance.ts` re-imports from `../src/payload.js` and keeps `export { envelopePayload, inertTrailerLine }` re-exports so `test/custom-round.ts` and every existing import site are untouched here.
- Green: full offline suite; the harness's own envelope tests now exercise the moved definitions through the re-export.
- Commit: `refactor(payload): move frozen envelope discipline from harness into src`

## Task 2 — The emission classifier: pure function + mode matrix

Files: `src/payload.ts`; `test/payload.test.ts`.

- Red: a matrix test for `classifyPayload(message) → { mode, emittedText, trailerBytes? }` pinning spec §3.2 exactly: `strict` (whole-message parse, incl. `"{}\n"` with emittedText `"{}\n"` — the emitter's newline append stays outside the classifier), `extracted` (first-line JSON + all-inert trailers; emittedText = first line; trailerBytes = bytes after the first line's newline, ≥ 1), `conflict` (first-line JSON + any non-inert trailer; verbatim), `unstructured` (prose, empty string, truncated first-line JSON; verbatim). Uses native `JSON.parse` only; no per-position retries.
- Implement: `classifyPayload` in `src/payload.ts` built on the Task-1 primitives.
- Green + commit: `feat(payload): emission classifier for the structured payload contract`

## Task 3 — Wire classification into the emission phase

Files: `src/codex.ts`; `test/worker.test.ts`.

- Red: lifecycle scenarios — a completed multi-message turn whose final message is first-line-JSON + prose trailer writes exactly the first line + `"\n"` to stdout (trailer on no sink); a strict final message emits verbatim `m + "\n"`; a conflict message emits verbatim; zero-message completion still writes nothing; classification adds no second write; a write throw during emission still fails the run (`recordFailure("output")` path unchanged). Verify each fails for the right reason before implementing.
- Implement: in the once-only emission phase (morning §3.4 site), run `classifyPayload` on the retained final message **before** invoking the sink: capture the projection, emit `emittedText` through the existing `emitMessage` accounting, and record the projection for `finish()`. `WorkerResult` gains `payload?: { mode: "strict" | "extracted" | "conflict" | "unstructured"; trailerBytes?: number }`. Attachment rule: only when final status is `completed` **and** emission was initiated — a mid-write cancellation or EPIPE-settled failure with bytes already delivered carries no `payload` (their receipts already tell that story). No other lifecycle branch changes.
- Preserve/replace/retire map for `test/worker.test.ts` (spec PE-04/PE-08): morning SC-01..SC-06 pins are preserved except where a fixture's final message carries a trailer — those scenarios get the extracted expectation; the maximal-frame scenario is re-sized by encoded frame bytes (~1 MiB frame, smaller message text) per spec §2.
- Green + commit: `feat(worker): classify and emit structured payload at settlement`

## Task 4 — Receipt projection

Files: `src/cli.ts`; `test/cli.test.ts`.

- Red: receipt pins — `worker.payload` present with exactly `{ mode, trailerBytes? }` on a completed emitted run; absent on failed, cancelled, not-started, and zero-message completed receipts; absent on the Task-3 post-write-cancellation scenario; every other receipt field byte-shape unchanged.
- Implement: pass `worker.payload` through into the `worker` receipt object (`src/cli.ts` worker-receipt composition, ~:240-250). No other receipt changes; the journal line is untouched.
- Green + commit: `feat(cli): project worker.payload in the receipt`

## Task 5 — Custom-round payload projection (PE-07)

Files: `test/custom-round.ts`; `test/custom-round.test.ts`.

- Red: an observed-record pin — the case record carries `workerPayload: { mode, trailerBytes? }` read from the CLI receipt (same projection pattern as `workerFailure`/`workerProgress`), degraded to absent when the receipt lacks it; whitelist stays bounded and content-free.
- Implement: extend the observed-record whitelist and projection in `test/custom-round.ts` (~:1027-1031 record composition).
- Green + commit: `test(custom-round): retain bounded worker payload projection`

## Task 6 — Docs sync

Files: `README.md`; `.agents/skills/turnhelm-routing/SKILL.md`.

- State the contract in both, consistently with spec §3.4: stdout carries at most one message; a message that is one JSON value, or a payload line plus inert prose, yields exactly the payload on stdout; conflicting structured content and non-JSON messages are emitted verbatim with `payload.mode` `conflict`/`unstructured` in the receipt; dropped trailer bytes are retained nowhere; stdout is a delimitor, not a validator, and still not a redactor; success is read from exit code + receipt, never stdout presence. Update the stdout-boundary sentences that today say only "at most one message". Symlink distribution unchanged.
- Commit: `docs: state the structured payload stdout contract in README and skill`

## Task 7 — Full verification

- `pnpm run typecheck` (or repo equivalent) + full offline suite green; coverage ≥ 80/80/80 on `dist/src/**`.
- Confirm no changes outside the §2 surface (`git diff --stat` against the spec's file list); confirm zero edits under sealed/evidence roots.
- Update this plan's checklist and the spec's §8 residual line if anything shifted; commit: `test: full-suite verification for the structured payload contract`

## Review focus (for the whole-branch acceptance review)

Five scenarios to attack, mapped to tasks: (1) a trailer that *almost* satisfies inertness — a parseable trailer line, a fence delimiter, a `"`-opened line — must yield `conflict`, never extraction (Tasks 2/3); (2) emission initiated then cancelled mid-write — bytes on stdout, `cancelled` receipt, **no** `payload` field (Tasks 3/4); (3) `"{}\n"` strict message producing `"{}\n\n"` stdout — pinned, not accidental (Tasks 2/3); (4) harness/product definition drift — after the move, the harness must have no private copy of the envelope rules (Task 1); (5) custom-round records must not retain trailer content, only the bounded projection (Task 5).

## Out of scope (explicit)

Provider-refusal stop semantics (spec §6.2 follow-up), calibration gate, Jev 451, usage retention, frontier coverage, `--output-schema` probe, any live/paid suite, any sealed artifact.
