# Oracle Timing Rule, Failure-Mode Docs, and Campaign Disposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the docs-only change set from the 2026-10-17 campaign spec — the oracle timing authoring rule, the worker failure-mode/read-only documentation, and the in-repo campaign disposition note.

**Architecture:** Three additive documentation edits (no `src/`, `test/`, or `assets/` change): two passages extended in lockstep across `README.md` and `.agents/skills/turnhelm-routing/SKILL.md`, plus one new dated note under `docs/validation/`. Verification is text checks plus the existing suite green with its doc-fragment pins unmodified.

**Tech Stack:** Markdown docs; `pnpm test` / `pnpm build` as gates.

**Spec:** `docs/superpowers/specs/2026-10-17-oracle-timing-and-campaign-disposition-design.md` (post-astra-revision, commit `b4fef42`)

## Global Constraints

- Docs-only: the staged diff touches exactly five files — `README.md`, `.agents/skills/turnhelm-routing/SKILL.md`, `docs/validation/2026-10-17-campaign-5df68f6-disposition.md` (new), the spec, this plan. No `src/`, `test/`, `assets/`, config, or dependency change; no live calls; sealed campaign artifacts outside the repo are never edited.
- Shared passages across README and SKILL: **verbatim-identical** for the OR-1 rule sentence; the DF-1 skill copies are the sanctioned compressed form of the README text (Task 2 Step 3), matching how that file already compresses its README counterparts; additions are additive — no existing sentence is reworded or deleted.
- The doc-fragment pins (`test/package.test.ts:129–176`, `test/init.test.ts:225–249`) must pass **unmodified** — if an edit would require touching a test, the edit is wrong.
- English, existing voice (long normative sentences, no marketing).
- Editing `SKILL.md` intentionally strands existing consumer installs: `init` refuses changed skill files and stops for owner reconciliation — that is the designed upgrade path under this spec's no-backward-compatibility constraint, not a defect to engineer around.
- Conventional Commits; no push (the user merges/pushes themselves).

## Review Focus

- A future roster author who reads only the skill (not the README) must still hit the timing rule → both files carry the identical sentence; pinned by Task 1's grep step.
- A consumer treating a schema-valid output or exit 0 as proof of correctness → DF-1(b) ties each named mode to consumer gating; pinned by Task 2's grep step.
- A future operator "fixing" the standing calibration-dev exit 3 by refitting the heading band → CD-1 states the do-not-refit instruction and its reason; pinned by Task 3's content checks.
- Reuse of retired case `42-coalescing` as-is in a future roster → CD-1 records its retirement; pinned by Task 3's content checks.
- Later drift between the README and SKILL copies of a shared passage → exact-sentence greps in both files (Tasks 1–2) plus the five-file staged-diff check (Task 4).

---

### Task 1: OR-1 — oracle timing rule in README and SKILL

**Files:**
- Modify: `README.md` (roster-authoring rule paragraph, currently lines 669–674)
- Modify: `.agents/skills/turnhelm-routing/SKILL.md` (harness paragraph carrying the same rule, the paragraph ending "…retired and replaced, not rewritten.")

**Interfaces:**
- Consumes: spec §3 OR-1.
- Produces: the shared rule sentence, exact text below — Task 4's diff check and any future reader depend on it appearing verbatim in both files.

- [ ] **Step 1: Insert the timing rule into the README rule paragraph**

Insert after "…so a mis-graded tie is caught by the roster itself;" and before "sealed oracles and recorded grades…", keeping the paragraph unbroken:

```markdown
a task whose oracle verdict depends on when an effect must happen — a
synchronous throw versus a deferred rejection, a same-turn identity window for
promises or handles, state visible before versus after settlement,
retry-after-settlement semantics — must state the timing policy it judges and
include one worked call-order example exercising the ambiguous boundary (for a
fetch that throws synchronously: whether the immediately following same-key
call must return the identical promise, and whether rejection is deferred to a
microtask), with the task text imposing exactly the policy the oracle judges;
```

(lowercase continuation `a task…` and trailing `;` because it joins the existing "an oracle whose verdict depends on ordering…" list inside one sentence; rewrap to the file's ~76-column style.)

- [ ] **Step 2: Insert the identical text into the SKILL harness paragraph**

Same insertion point relative to the ties sentence in `.agents/skills/turnhelm-routing/SKILL.md`; identical words, rewrapped only for that file's width.

- [ ] **Step 3: Verify verbatim identity and placement**

Run: `grep -c "must state the timing policy it judges and" README.md .agents/skills/turnhelm-routing/SKILL.md`
Expected: `1` for each file. Then `grep -n "timing policy" README.md .agents/skills/turnhelm-routing/SKILL.md` — one hit per file, both inside the roster-rule paragraph (not a new paragraph).

- [ ] **Step 4: Commit**

```bash
git add README.md .agents/skills/turnhelm-routing/SKILL.md
git commit -m "docs: extend roster authoring rule with oracle timing policy"
```

### Task 2: DF-1 — read-only semantics and observed failure modes

**Files:**
- Modify: `README.md` ("Read-only by default" bullet, currently lines 279–281; "Completion is not verification" bullet, currently lines 338–342)
- Modify: `.agents/skills/turnhelm-routing/SKILL.md` ("Default sandbox is `read-only`…" sentence in the Execute section; end of the first "Interpret results" paragraph)

**Interfaces:**
- Consumes: spec §3 DF-1.
- Produces: the read-only clause and failure-modes sentence, exact text below.

- [ ] **Step 1: Extend the README read-only bullet**

Append to the bullet (currently ending "…restrictions on protected paths."):

```markdown
`--sandbox read-only` denies writes, not reads: read-only mode itself does not
prohibit reading, though whether any specific file is readable still depends on
host permissions. The 2026-10-17 validation campaign observed a worker claim it
could not read a file in a read-only run; the internal cause of that refusal is
unresolved.
```

- [ ] **Step 2: Extend the README completion bullet**

Append after "Never treat native completion as task verification.":

```markdown
Observed worker failure modes (2026-10-17 campaign, every one caught by
consumer-side gates): a wrong refusal, claimed completion with the
implementation unchanged, and schema-valid but value-wrong output — native
completion and schema framing never establish semantic correctness.
```

- [ ] **Step 3: Add the matching skill sentences**

In the skill's Execute section, after the "Default sandbox is `read-only`…" sentence: "Read-only denies writes, not reads — host permissions still govern any specific file; the 2026-10-17 campaign observed a worker claim a read-only session cannot read files (cause unresolved)." At the end of the first Interpret-results paragraph: "Observed failure modes (2026-10-17): wrong refusal, claimed completion with the implementation unchanged, schema-valid but value-wrong output — all consumer-gated." (Skill copies are the compressed form of the README text, matching how that file already compresses its README counterparts.)

- [ ] **Step 4: Verify presence in both files**

Run: `grep -c "denies writes, not reads" README.md .agents/skills/turnhelm-routing/SKILL.md` → `1` each.
Run: `grep -c "claimed completion with the" README.md .agents/skills/turnhelm-routing/SKILL.md` → `1` each.

- [ ] **Step 5: Run the fragment-pinned tests unmodified**

Run: `pnpm test`
Expected: full suite green (stock count 637/637 at this baseline), zero test-file changes (`git status --porcelain test/` empty).

- [ ] **Step 6: Commit**

```bash
git add README.md .agents/skills/turnhelm-routing/SKILL.md
git commit -m "docs: state read-only semantics and observed worker failure modes"
```

### Task 3: CD-1 — campaign disposition note

**Files:**
- Create: `docs/validation/2026-10-17-campaign-5df68f6-disposition.md`

**Interfaces:**
- Consumes: spec §3 CD-1; the sealed report at `/Users/zhangxiao/.local/state/turnhelm/validation-20261017-5df68f6-b3yPqC/final-report/REPORT.md` (read-only reference; never edited).
- Produces: the in-repo record future roster authors and band owners read.

- [ ] **Step 1: Write the note**

Sections, in the dated-note style of `docs/validation/`: (1) verdict line — COMPLETE-WITH-FAILURES, 96/101 pass, HEAD `5df68f6…`, report path and seal `bddf594a…`; (2) the five failures with their evidence-backed categories (feature-prose wrong refusal; 12-redaction claimed completion with unchanged implementation; 30-incident and 37-capacity value-wrong output; 42-coalescing contract-assertion failure with the timing ambiguity stated, grade preserved); (3) open alarms with standing instructions — heading-en selected `frontier` 3/3 against band `[fast, balanced]`, holdout clean, n=1: **do not refit the band on this evidence**, investigate classifier-side or via a matched diagnostic; 31/50 natural business selections out-of-band (all below their band floor, per-case data in the sealed `report.json`) and all four frozen natural failures at the fast tier: no routing/mapping/band change without a matched, separately authorized diagnostic; frontier_xhigh/frontier_max zero natural selections in 50 cases; (4) retirement: case `42-coalescing` is retired; reuse only as a v2 stating its timing policy; (5) live-coverage gaps not exercised: API-key billing, direct non-proxy Jev, deliberate credential refresh, rate/usage limits, operator cancellation.

- [ ] **Step 2: Content checks**

Run each; expected `1` or more lines each: `grep -c "bddf594a" docs/validation/2026-10-17-campaign-5df68f6-disposition.md`; `grep -ci "do not refit" docs/validation/2026-10-17-campaign-5df68f6-disposition.md`; `grep -c "42-coalescing" docs/validation/2026-10-17-campaign-5df68f6-disposition.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/validation/2026-10-17-campaign-5df68f6-disposition.md
git commit -m "docs: record 2026-10-17 campaign disposition and open alarms"
```

### Task 4: Final verification

**Files:** none modified.

- [ ] **Step 1: Full gate**

Run: `pnpm test && pnpm build`
Expected: green build, suite passing, `test/` untouched (`git status --porcelain test/` empty).

- [ ] **Step 2: Five-file staged diff**

Run: `git add -A && git diff --stat main --cached`
Expected: exactly `README.md`, `.agents/skills/turnhelm-routing/SKILL.md`, `docs/validation/2026-10-17-campaign-5df68f6-disposition.md`, the spec, this plan — nothing else.

- [ ] **Step 3: Whitespace gate**

Run: `git diff --check main` → no output.

- [ ] **Step 4: Report**

Summarize: files changed, suite result, and the standing consequence for existing installs (skill copies in already-initialized projects are refused by `init` until their owner reconciles — by design). No push; the user merges.
