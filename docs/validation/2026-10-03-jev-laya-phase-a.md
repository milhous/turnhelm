# Jev/Laya Phase A smoke validation

Date: 2026-10-03

## Commands

```bash
npm test
TURNHELM_ALLOW_HOSTED_JEV=1 npm run test:live
npm audit --audit-level=high
git diff --check
git status --short
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

## Authorized live smoke result (2026-10-03)

- Real Laya: 24/24 passed; selected_profiles `direct:8,fast:8,deep:8`; p50 69.4ms; p95 98.6ms. Laya ran from the existing loopback `laya-serve` typed-decisions service.
- Real Jev: 24/24 passed; selected_profiles `direct:8,fast:8,deep:8`; p50 282.2ms; p95 729.1ms.

This is smoke evidence, not a general quality benchmark. No paths, prompts,
request/response bodies, headers, key values, or logs are recorded.

## Offline hardening result (2026-10-03)

No new live calls were made. The authorized live result above remains the
dated smoke evidence, not a rerun or general quality benchmark.

- Hermetic `npm test`: 168/168 passed; 0 failed, skipped, or cancelled.
- Hermetic `npm run test:coverage`: 168/168 passed on Node 24.21.0 and 26.5.0.
- Source-only aggregate coverage: lines 99.10%; branches 93.39%; functions 100%.
- Source module coverage (lines / branches / functions):
  - `cli`: 100% / 100% / 100%.
  - `codex`: 100% / 85.71% / 100%.
  - `config`: 96.43% / 84.62% / 100%.
  - `route`: 100% / 93.33% / 100%.
  - `systemone`: 100% / 100% / 100%.
  - `task`: 100% / 100% / 100%.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `git diff --check`: passed.

Classifier credentials and hosted opt-in were unset for the offline commands.
CLI characterization used temporary config/executable fixtures and ephemeral
loopback HTTP only; neither real Codex nor a hosted service was invoked. The
source gate covers every production module without including test files.
