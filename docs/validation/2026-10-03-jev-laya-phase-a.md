# Jev/Laya Phase A smoke validation

Date: 2026-10-03

## Commands

```bash
npm test
TURNHELM_ALLOW_HOSTED_JEV=1 npm run test:live
npm audit --audit-level=high
git diff --check
```

Run the live command only with approved real services and credentials. It must
fail clearly when a service or credential is unavailable; fixtures are never
substituted.

## Required gates

- A local Laya service is running on a loopback URL (`127.0.0.1` or `::1`).
- Hosted Jev credentials/service are available through the normal environment.
- Direct Jev validation uses `hostedJev.enabled: true` and
  `TURNHELM_ALLOW_HOSTED_JEV=1`.

The gate values themselves are not recorded.

## Smoke matrix and output

The suite preserves six labelled bilingual cases (`direct`, `direct`, `fast`,
`fast`, `deep`, `deep`) and makes 24 calls per backend (four repeats). Output
is scalar only: backend/source, selected profile, call count, p50/p95 latency,
and pass/fail status. Prompts, responses, request bodies, headers, keys, and
other credentials must never be logged. No fixtures may be used, and model
catalogues must not be mutated.

This is smoke coverage, not a quality benchmark.

## Future calibration (out of scope)

Comparative quality calibration, larger datasets, confidence policies, and
model-catalog experiments are future work and are explicitly out of scope for
this Phase A MVP.
