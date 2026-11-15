# Troubleshooting

## Server does not start

Check:

- Node.js is `>=20 <25`;
- dependencies were installed with `npm ci`;
- stdin and stdout are available to the MCP host;
- nothing writes logs or banners to stdout;
- the host uses an absolute source entry-point path.

## `CONFIGURATION_ERROR`

Verify:

- `LUCY_MEMORY_TOKEN` is present and contains no line break or NUL;
- permissions contain only `memory:read` and/or `memory:propose`, without duplicates;
- timeout is an integer from 1 to 300000;
- exactly one of `LUCY_MEMORY_BASE_URL` and `LUCY_MEMORY_TRANSPORT_MODULE` is set;
- the base URL is HTTPS unless explicit loopback development mode is enabled;
- a custom transport path is absolute or a `file:` URL.
- optional body and per-task concurrency limits are positive integers;
- an optional admission module is an absolute path or `file:` URL.

## Authentication or authorization failure

Confirm the credential belongs to the selected Lucy environment, has not been revoked, and includes the permission required by the operation. Do not print the credential while debugging.

## `invalid_scope`

`scope` must be an object, never a string. Use `{ "kind": "user" }`, `{ "kind": "workspace" }`, or `{ "kind": "project", "id": "<project-id>" }`.

A minimal valid recall is `{ "query": "database", "scope": { "kind": "user" } }`.

## Empty recall

Empty results are not an error and do not establish that memory is absent. Start with concise literal, distinctive substrings; try spelling and spacing variants; use known keys, kinds, and scopes when available; then broaden or narrow the query and filters iteratively.

Check that:

- memory was approved and remains active;
- the scope and authorized project ID match;
- key and kind filters are not too narrow;
- the query describes durable approved memory.

A successful response with an empty `results` array means zero visible matches. Authentication, authorization, rate-limit, timeout, and service failures are errors instead; diagnose those rather than treating them as empty recall.

Pending, superseded, revoked, forgotten, rejected, and expired records are not normal recall results.

## Proposal remains pending

Pending is expected until Lucy approves the proposal or applies an enabled auto-memory policy. The MCP server cannot approve it. Poll with bounded backoff.

## `version_conflict`

Recall current memory, review its latest version, and submit a new replacement proposal with the current `expected_version` and a new idempotency key.

## Rate limit, timeout, or unavailable service

Honor a bounded retry delay. The built-in transport retries proposals only. Recall and status can consume credits, so decide explicitly whether an ambiguous call should be repeated.

MCP admission rejections use `rate_limit`, status 429, and may include `retry_after` milliseconds.
`admission_unavailable` means the configured shared authority failed or returned a malformed decision; it
fails closed and Agent Memory was not called. Check the shared authority and its low-cardinality
`source=mcp` metrics. Do not add a local-map fallback or unbounded retry loop.

The optional `onOperabilityEvent` callback receives privacy-safe `event: "tool"` records. Admission
failures use `outcome: "error"` and only the bounded `error_code` values `payload_too_large`,
`rate_limit`, or `admission_unavailable`; `throttled: true` appears only for `rate_limit`. Callback
exceptions and rejected promises never change tool results.

For beta certification, configure candidate ceilings in the deployment-owned admission module, exercise
multiple MCP instances/tasks against the same authority, and record MCP-tagged QPS, latency, errors, and
rejections. Choose production ceilings from those measurements and approved spend policy; this package
deliberately supplies no guessed spend or SLO values.

## `malformed_response`

Confirm the endpoint supports Agent Memory HTTP v1 and any custom transport returns an integer status, JSON-compatible body, correct byte length, and bounded response. The client rejects oversized or schema-invalid responses.

## Host discovers the wrong tools

The supported list is exactly `memory_recall`, `memory_propose`, and `memory_proposal_status`. Check that the host launches this checkout and does not merge stale tool metadata from another server.

## Hermes installation fails

Confirm Linux `flock` support, absolute paths, a protected profile, a trusted Node runtime, the pinned source commit, and an offline npm cache containing the lockfile dependencies. Remove any raw token from legacy YAML before installation.

## Collect diagnostics safely

Include versions, normalized error codes, HTTP status, bounded request IDs, and exact reproduction steps. Exclude credentials, full environment dumps, private memory, raw upstream responses, and local diagnostic archives.
