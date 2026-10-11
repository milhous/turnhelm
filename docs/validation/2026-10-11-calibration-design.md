# Frozen Calibration Design (v1) — 2026-10-11

Status: frozen. Local (free) classifier execution is authorized under this
design; any worker-executing comparison round requires a fresh approval
before it runs. Nothing in this document justifies editing prompts, tasks,
bands, or gates to make a sample pass.

## Motivation

Two open findings demand a predeclared, replayable calibration:

- RR-08 (light-task overselection / language parity): one validation round
  matched 2/3 predeclared bands; the EN heading task selected `frontier`
  (outside `fast`/`balanced`) while its ZH equivalent selected `balanced`.
- routing-policy-calibration-cost-quality: 6/6 valid choices, 5/6 band
  agreement, but no predeclared comparative quality/time/cost oracles.

Cause investigation (2026-10-11, 70 free local classifies, raw results in
the appendix): the typed-decisions classifier is
deterministic per stimulus — every stimulus produced the identical choice
and confidence across 5 repeats. The mismatch is not noise, not language,
not keyword, not length: near-paraphrases of the same instruction flip the
choice (`heading-en` frozen text → `frontier`; "Rename README's title to
Turnhelm and touch nothing else" → `fast`). The frozen heading-en text sits
near a decision boundary; micro-phrasing moves the argmax. Reported
confidence is uniformly low (0.01–0.12) and carries no separation.

## Stimuli

The frozen corpus (`test/fixtures/live-acceptance.json`, `version: 2`) is
the sole stimulus set: eight tasks, four `pairId`s, one `en`/`zh` pair per
pairId, `dev` and `holdout` splits, three trials each, exactly as prepared
by the `calibration-dev` and `calibration-holdout` suites.

## Non-keyword band rationale (predeclared)

Bands judge what the task's *result* requires, never keyword presence:

- `heading` / `decoy` (dev / holdout light pair): a single-line content edit
  with an explicit scope restriction — acceptance is that one line and only
  that line changes. Lightest sufficient profiles: `fast`, `balanced`.
- `race` (dev hard pair): causal tracing across transaction/enqueue/worker
  ordering plus a deterministic regression test — coupled constraints and
  required verification. `deep`, `frontier`, `frontier_xhigh`.
- `auth` (holdout hard pair): multi-system security review with attack
  timelines, trade-offs, and a remediation plan; no file changes. Highest
  reasoning tier justified. `frontier`, `frontier_xhigh`, `frontier_max`.

## Oracles

1. Routing oracle (classifier-only, free): the selected profile is a legal
   profile ID (engineering fact) and lies inside the pair's predeclared
   band (policy fact). Verdict and policy are recorded independently;
   out-of-band-but-legal completes the roster and reports `policy-mismatch`
   (exit 3); illegal/failed responses stop the round (exit 1).
2. Task-result oracle (worker, gated): where a pair has an executable form,
   the oracle is the task's result — the actual diff (exactly the allowed
   change) and the fixed expected artifact — never the profile that
   produced it.
3. Comparative cost/quality/time oracle (worker, gated, fresh approval
   required): per pair, at most two worker runs — the classifier's
   selection and the band's lightest profile — comparing (a) task-result
   verdict, (b) wall-clock duration, (c) reported usage tokens. Any
   savings or sufficiency claim cites only this predeclared comparison.

## Execution protocol

- Dev split executes first; holdout executes once, after dev, with no
  tuning in between (there is no tuning step in this design).
- Both splits run through the acceptance entry (`--prepare` → human sha256
  approval → `--execute`) against the local Laya backend only; hosted Jev
  stays disabled; workers stay at cap 0 for classifier-only suites.
- Three trials per stimulus are all recorded; the deterministic backend is
  expected to repeat — divergence across trials is itself a finding.
- Evidence lives in the acceptance journal; no reruns, no replay, no prompt
  edits. A failed band match is recorded as such.

## Interpretation limits (predeclared)

- Band agreement on 24 classifier calls is routing-policy evidence only,
  not general accuracy, quality, or savings.
- The local deterministic classifier's boundary sensitivity means a single
  frozen text's band placement is a property of that text; changing the
  text invalidates the calibration rather than fixing it.
- Language parity is judged per pair (en vs zh of the same pairId), not
  across pairs.

## Appendix: raw classify results (2026-10-11)

70 local Laya classifies via `requestTaskChoice` (frozen corpus tasks plus
variants; 5 repeats each; per-stimulus results were identical across
repeats, so one line per stimulus; `ms` from the first repeat):

```json
{"id":"heading-en","choice":"frontier","confidence":0.0156,"ms":373}
{"id":"heading-zh","choice":"balanced","confidence":0.0283,"ms":108}
{"id":"race-en","choice":"frontier","confidence":0.0401,"ms":121}
{"id":"race-zh","choice":"frontier","confidence":0.0173,"ms":153}
{"id":"decoy-en","choice":"balanced","confidence":0.0535,"ms":110}
{"id":"decoy-zh","choice":"fast","confidence":0.1152,"ms":112}
{"id":"auth-en","choice":"frontier","confidence":0.0486,"ms":123}
{"id":"auth-zh","choice":"frontier","confidence":0.0893,"ms":158}
{"id":"heading-en-v1","choice":"frontier","confidence":0.0149,"ms":103}
{"id":"heading-en-v2","choice":"fast","confidence":0.0352,"ms":99}
{"id":"heading-zh-v1","choice":"balanced","confidence":0.0198,"ms":109}
{"id":"heading-zh-v2","choice":"fast","confidence":0.056,"ms":107}
{"id":"decoy-en-v1","choice":"balanced","confidence":0.1048,"ms":105}
{"id":"auth-zh-v1","choice":"frontier","confidence":0.0095,"ms":122}
```

Variant texts: `heading-en-v1` "Update the README title line to say
Turnhelm; no other lines change." / `heading-en-v2` "Rename README's title
to Turnhelm and touch nothing else." / `heading-zh-v1` "把 README 的标题更新为
Turnhelm，其他行都不改。" / `heading-zh-v2` "将 README 标题改成 Turnhelm，只动这一行。"
/ `decoy-en-v1` "In the docs page, retitle the section \"Getting started\"
to \"Quick start\"; edit only that heading line." / `auth-zh-v1`
"评审多租户服务里会话撤销与权限传播的正确性，给出攻击面分析、证据与最小修复计划；不要修改文件。"

Executed baseline (acceptance entry, local Laya, journals retained at
prepare time): calibration-dev exit 3 `policy-mismatch` — heading-en x3
`frontier` (mismatch), heading-zh x3 `balanced`, race-en/zh x3 `frontier`
(all match); calibration-holdout exit 0 `pass` — decoy-en x3 `balanced`,
decoy-zh x3 `fast`, auth-en/zh x3 `frontier` (all match).
