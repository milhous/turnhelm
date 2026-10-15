# Classifier Usage Evidence — Execution Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Date: 2026-10-15. Branch: `feat/classifier-usage-evidence`. Spec: `docs/superpowers/specs/2026-10-15-classifier-usage-evidence-design.md` (post-Astra revision; findings dispositioned in its §6). Baseline: `ec6bcb4`.

**Goal:** Project Laya's already-received classifier usage facts (`input_tokens`, `state_tokens`) into the routing decision, receipt, and journal; change nothing else.

**Architecture:** One projection added where `validateChoice` already enforces the truncation guard (`src/systemone.ts`), threaded through the existing conditional-spread pattern that `confidence` uses (`route.ts` → `cli.ts` receipt, `journal.ts` entry). Per-field validation copies the `usageSnapshot` idiom from `src/codex-events.ts:47–79`: own-property, safe non-negative integer, frozen, degrade to absent.

**Tech Stack:** TypeScript (Node >=24.5.0), `node:test` + `node:assert/strict`, no new dependencies.

## Global Constraints

- Laya only; hosted Jev never projects — stays `"unreported"` (spec §3.3).
- Exactly `input_tokens` and `state_tokens`, Laya's field names verbatim (spec §3.1).
- The truncation guard stays a hard failure and runs before any projection (spec §2).
- Usage is evidence, never a gate: no run/route/probe outcome changes on any usage shape (spec §3.2).
- Receipt stays `"unreported"` when nothing validated; failed/cancelled routing never journals the field (spec §3).
- Docs: `README.md` and both byte-identical skill copies stay byte-identical after the edit (spec §2).
- Conventional commits; no auto-push; offline only — no Laya/Jev/worker execution, no live suites.

## Review Focus

Spec-implied inputs no ordinary happy-path test exercises; each pinned in the owning task:

1. Guard-passing reply whose usage token fields are invalid (string, negative, float, non-safe-integer) — fields omit individually; all-invalid yields no `usage` key and the route still succeeds (Task 1).
2. Truncating reply with valid token counts — guard fails the route; projection never happens (Task 1, precedence).
3. Hosted-Jev reply carrying a usage envelope — never projected (Task 1).
4. Failed/cancelled routing — journal entry and receipt carry no projection (Task 2).
5. Selection where Laya omitted `usage` content entirely (only guard keys present) — no `classifierUsage` on decision; receipt literal `"unreported"` (Tasks 1–2; existing `test/cli.test.ts:422,646,666` pins must stay green).

---

### Task 1 — Usage projection in `validateChoice` (`src/systemone.ts`)

**Files:**
- Modify: `src/systemone.ts:285–312` (`TaskChoice`, `validateChoice`)
- Test: `test/route-journal.test.ts` (the `withReply`/`requestTaskChoice` seam, next to the confidence tests at :56–75)

**Interfaces:**
- Produces: `TaskChoice` gains `usage?: Readonly<{ input_tokens?: number; state_tokens?: number }>` — present iff at least one field validated; Task 2 consumes it as `decision.classifierUsage`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a guard-passing Laya usage projects exactly its token facts", async () => {
  const choice = await requestTaskChoice(fixtureConfig(), "Describe the routing task", "laya",
    new AbortController().signal, withReply({ answers: { route: { type: "choice", choice: "fast" } },
      usage: { truncated: false, state_tokens_dropped: 0, input_tokens: 1204, output_tokens: 0, state_tokens: 1523 } }));
  assert.deepEqual(choice.usage, { input_tokens: 1204, state_tokens: 1523 });
});

test("invalid usage token fields omit individually and never gate", async () => {
  // per-field degradation: "17", -1, 2.5, 2**53 omit; missing key omits; all-invalid → no usage key
  // reuse the existing tolerance-test loop shape at route-journal.test.ts:63–75
});

test("a hosted Jev reply never projects usage", async () => {
  // backend "jev" with fakeEnv; reply carries a usage envelope; choice.usage is undefined
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/route-journal.test.js`
Expected: FAIL — `choice.usage` is `undefined` (no projection exists).

- [ ] **Step 3: Implement the projection**

Add `usage?:` to `TaskChoice` (`src/systemone.ts:285`). In `validateChoice`, after the truncation guard block (:299–305) and only for `backend === "laya"`, project with the `usageSnapshot` idiom: for each of `input_tokens`, `state_tokens` — own-property, `Number.isSafeInteger`, `>= 0` — collect, freeze; attach via conditional spread iff non-empty. Discard everything else in the envelope.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/route-journal.test.js dist/test/task-routing.test.js`
Expected: PASS, including the untouched truncation-guard matrix at `test/task-routing.test.ts:199–216` (guard precedence).

- [ ] **Step 5: Commit**

```bash
git add src/systemone.ts test/route-journal.test.ts
git commit -m "feat(systemone): project bounded Laya classifier usage on guard-passing replies"
```

### Task 2 — Thread `classifierUsage` through decision, receipt, journal

**Files:**
- Modify: `src/route.ts:75–79` (decision construction), `src/cli.ts:214–226` (receipt), `src/journal.ts:29–34` (selection entry)
- Test: `test/route-journal.test.ts` (decision + journal), `test/cli.test.ts` (receipt, next to the :422 pin)

**Interfaces:**
- Consumes: `TaskChoice.usage` from Task 1.
- Produces: `TaskDecision.classifierUsage?: Readonly<{ input_tokens?: number; state_tokens?: number }>`; receipt `classifierUsage` is that object or the literal `"unreported"`; journal entry gains `classifierUsage` on selection only.

- [ ] **Step 1: Write the failing tests**

Decision/journal (route-journal.test.ts, mirroring the confidence tests at :77–105): a `routeTask` with a usage-bearing reply puts `classifierUsage` on `decision` and in the journaled entry; a no-usage reply yields neither; and `classifierUsage` joins the denylist loops for failed (:131) and cancelled (:150) entries — `assert.ok(!(key in entry))` for each.

Receipt (cli.test.ts): a selected run with usage → `receipt.classifierUsage` deep-equals the frozen projection; without usage → `"unreported"`; existing pins at :422, :646, :666 unchanged and green.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run build && node --test dist/test/route-journal.test.js dist/test/cli.test.js`
Expected: FAIL — decision/receipt/journal lack `classifierUsage`.

- [ ] **Step 3: Implement the threading**

`route.ts`: carry `usage` out of `requestTaskChoice` (:64) into the decision via the same conditional spread as `confidence` (:78). `cli.ts`: replace the hardcoded literal (:215) with `classifierUsage: routing.status === "selected" && routing.decision.classifierUsage !== undefined ? routing.decision.classifierUsage : "unreported"`. `journal.ts`: after the `confidence` line (:34), the same conditional append for `classifierUsage`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run build && node --test dist/test/route-journal.test.js dist/test/cli.test.js dist/test/task-routing.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/route.ts src/cli.ts src/journal.ts test/route-journal.test.ts test/cli.test.ts
git commit -m "feat(route): surface classifierUsage in decision, receipt, and journal"
```

### Task 3 — Docs sync

**Files:**
- Modify: `README.md:350`, `.claude/skills/turnhelm-routing/SKILL.md:237`, `.agents/skills/turnhelm-routing/SKILL.md:237`

- [ ] **Step 1: Update the three claims identically**

Replace each "`classifierUsage` is `\"unreported\"`" claim with: on a Laya selection the receipt and journal may carry a bounded `classifierUsage` projection of exactly `input_tokens`/`state_tokens` (Laya's field names, non-negative safe integers); absent, invalid, or hosted-Jev selections read `"unreported"`; usage is evidence and never gates an outcome. Keep both SKILL.md copies byte-identical.

- [ ] **Step 2: Verify template coupling holds**

Run: `pnpm run build && node --test dist/test/init.test.js dist/test/package.test.js`
Expected: PASS (packaged-template and package pins accept the edited skill).

- [ ] **Step 3: Commit**

```bash
git add README.md .claude/skills/turnhelm-routing/SKILL.md .agents/skills/turnhelm-routing/SKILL.md
git commit -m "docs: state the classifierUsage projection in README and routing skill"
```

### Task 4 — Full offline verification

- [ ] **Step 1: Full suite with coverage gate**

Run: `pnpm run test:coverage`
Expected: all tests pass; line/branch/function coverage >=80/80/80 on `dist/src/**`.

- [ ] **Step 2: Working tree contains only the four commits' changes**

Run: `git status --short && git log --oneline ec6bcb4..HEAD`
Expected: clean tree, exactly the three task commits on `feat/classifier-usage-evidence`. No push — merge stays with the user.
