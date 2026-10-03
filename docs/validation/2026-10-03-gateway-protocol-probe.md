# Codex gateway protocol admission probe

Date: 2026-10-03

## Verdict: blocked

The installed Codex release exposes enough of the child-provider request shape
for a future probe, but this run did **not** admit the gateway contract. A
successful real upstream stream was not accepted by the stock child, and the
native subagent smoke did not produce an independent child thread. Per the
implementation plan, stop here: do not implement a gateway fallback, model
catalog patch, Hook, or second provider.

No prompt text, request or response bodies, authorization values, bearer
values, thread IDs, account IDs, or other credentials are stored in this
report. All observations below are field names, value types, status classes,
or counts only.

## Runtime and clean baseline

- Codex version: `0.160.0` (`codex-cli 0.160.0`).
- `codex --help` exited successfully.
- The repository was clean before and after the probe apart from this report.
- The child used `codex exec --ephemeral --ignore-user-config`; the disposable
  working directory was a separate temporary Git repository.
- Digests of the existing `CODEX_HOME` configuration, `auth.json`, and
  profile files matched before and after the probe. The initial snapshot
  included `models.json` (which was absent); Codex also refreshed its separate
  `models_cache.json` during the model-catalog attempt, and that file was not
  included in the initial digest. Therefore a strict no-model-catalog-change
  claim cannot be made. No Turnhelm process wrote a user-level Codex file.

## Sanitized admission facts

| Fact | Observation |
|---|---|
| Child-only provider override | The stock child accepted `model_provider` plus an inline `model_providers.<id>` override containing a loopback `base_url`, `wire_api = "responses"`, and `requires_openai_auth = true`; no global configuration was changed. |
| Upstream source | The installed runtime contains the packaged `chatgpt_base_url` value `https://chatgpt.com/backend-api/` and the `codex/responses` path. The relay derived the real model endpoint from those constants without reading Codex auth. |
| Sentinel acceptance | A child launched with the virtual model sentinel `turnhelm-sentinel` emitted `thread.started`, `turn.started`, and fallback model-metadata diagnostics, and sent a `POST` to the loopback recorder. The sentinel therefore reached the local provider path. |
| Model path | `$.model` — `string`. |
| Reasoning-effort path | `$.reasoning.effort` — `string` on the catalog-backed `gpt-6.1-sol` request. The sentinel fallback-metadata request omitted this optional field. |
| Thread-id sources | The Responses request carried `thread-id` and `session-id` headers (HTTP string values); the body contained `$.client_metadata.thread_id` (`string`), and the sanitized turn-metadata header contained `$.thread_id` (`string`). No value was retained. |
| Request-class candidates | The sanitized `x-codex-turn-metadata` JSON contained `$.request_kind`, `$.thread_source`, and `$.turn_trigger`, all `string`. A human/subagent distinction was not admitted because the subagent smoke could not reach a successful turn. |
| Streaming surface | The recorder received streamed HTTP responses and preserved status, headers, and chunks without buffering. The real upstream returned `403` for model-catalog requests and `400` for Responses requests; the stock child ended with `turn.failed` rather than accepting a successful streamed model response. |

The recorder saw only loopback requests with redacted path segments. POST
requests included the routing fields above plus a boolean `$.stream`; unrelated
input, tool-schema, and metadata fields were preserved in the relay and were
not logged as values.

## Native subagent smoke

One native read-only subagent request was requested from the stock Codex child.
The upstream failure occurred before delegation, so the recorder saw no
subagent Responses request and no independent child thread id. The probe did
not install a Hook and did not attempt to rewrite a collaboration item.

## Transport notes

The Codex child inherited machine proxy variables that prevented its HTTP
client from reaching loopback. Removing the six HTTP(S)/ALL proxy variables
for the child allowed the recorder to receive requests; the recorder itself
used the existing proxy only to relay to the real upstream. This is an
environment diagnostic, not an admitted production workaround. A direct
proxy-stripped child without the recorder also timed out before a successful
upstream response.

## Stop decision

Required facts are missing: (1) a successful streamed response accepted by the
stock child and (2) an independent native subagent thread/request-class
observation. The gateway plan is therefore **blocked at Task 1** for Codex
`0.160.0`. Future work must rerun this admission gate on a release/environment
where those facts can be observed; it must not guess the missing field shape
or build the gateway around this partial capture.
