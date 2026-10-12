# Hosted Jev (RR-07) authorized diagnostic — 2026-10-12

Status: completed diagnostic round. Does not close RR-07 (that requires the
J4 worker evidence, which the origin's current answer makes impossible from
this host). No source changes resulted.

## Scope and approval

User granted plenary authorization for the three deferred items on
2026-10-12; this round executes Investigation J1+J2 from
`docs/superpowers/plans/2026-10-11-routing-reliability.md`: read-only recheck
of the sealed failure evidence, then fixed, bounded, non-speculative
diagnostics against the official host. One probe, one typed-failure
projection, no retries, no key values read, no auth/TLS/proxy changes.

## Sealed prior evidence (J1, 2026-10-11)

The standard-chain round recorded the hosted Jev attempt as
`request / HTTP null / ETIMEDOUT` at 266 ms (whole case 345 ms, exit 1),
root cause unknown, with no attribution to DNS, proxy, TLS, region, account,
or vendor.

## Commands and raw results (J2, 2026-10-12, this host)

| Step | Result |
| --- | --- |
| `dscacheutil -q host -a name api.typesafe.ai` | 104.18.25.46, 104.18.24.46 (v6: 2606:4700::6812:182e/192e) |
| `dig +short api.typesafe.ai A` (configured resolvers) | 104.18.25.46, 104.18.24.46 |
| `dig +short @zelda.ns.cloudflare.com api.typesafe.ai A` (authoritative) | 104.18.24.46, 104.18.25.46 — identical set |
| `nc -vz -G 5 104.18.25.46 443` | succeeded |
| `openssl s_client -connect …:443 -servername api.typesafe.ai -brief` | TLS 1.3 established, peer certificate CN=typesafe.ai |
| `turnhelm doctor --probe` (scratch project, laya disabled, jev enabled, one request) | `backend.jev: fail` — "did not complete with a valid choice within its budget" |
| One `requestTaskChoice` direct call, typed failure projection only | `kind=http`, `httpStatus=451`, `code=null`, 706 ms |

Environment gates at probe time: `TYPESAFE_API_KEY` present (value never
read), `TURNHELM_ALLOW_HOSTED_JEV=1`.

## Interpretation (predeclared limits)

- Local resolution now matches the authoritative answer; the earlier
  local-resolver A-record mismatch (resolver answers differed from the
  authoritative set; the source of those answers was never identified) no
  longer reproduces. TCP and TLS to the
  origin edge succeed, and the HTTP round trip completes in ~0.7 s.
- The hosted failure mode changed from transport-level (`ETIMEDOUT`, 2026-10-11)
  to HTTP-level: the origin edge returns **451 Unavailable For Legal Reasons**
  to `POST /v1/systemone` from this host.
- 451 is an origin-side answer. These data do not identify *why* (geo,
  legal, account, or vendor decision), and no such cause is claimed.
- No turnhelm-side defect: the client reaches the origin, classifies the
  non-2xx answer as `kind=http` with the observed status, and fails closed
  without spending a worker run. Per J3, no patch is made for this.
- RR-07 remains open with a narrowed unknown: transport is ruled out; the
  blocking fact is the origin's 451. Closing per J4 (real jev/dual worker
  evidence) requires that answer to change first and a separate cost-scoped
  approval.
