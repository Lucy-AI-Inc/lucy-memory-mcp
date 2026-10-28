# HTTP API and transport

Lucy Memory MCP uses Agent Memory HTTP v1 behind the stdio server.

## Base URL

Configure a Lucy deployment base URL, for example:

```text
https://www.trylucy.ai
```

The transport appends:

```text
/api/lucy/agent-memory/v1
```

The base URL must use HTTPS. Trailing slashes are normalized. Cleartext HTTP is refused unless it targets loopback and the development-only opt-in described below is explicit.

## Authentication

Every request sends:

```http
Authorization: Bearer <Lucy credential>
Accept: application/json
```

The credential determines tenant, actor, user, workspace, and project authority on Lucy. The client does not send tenant or account IDs.

## Routes

| Client operation | Method | Route |
|---|---|---|
| `recall` | POST | `/api/lucy/agent-memory/v1/recall` |
| `propose` | POST | `/api/lucy/agent-memory/v1/proposals` |
| `proposal-status` | GET | `/api/lucy/agent-memory/v1/proposals/{proposal_id}` |

Proposal POST requests also send:

```http
Idempotency-Key: <idempotency_key>
Content-Type: application/json
```

## Request and response contract

The machine-readable contract is:

[`../contracts/agent-memory-api.contract.json`](../contracts/agent-memory-api.contract.json)

The HTTP layer uses the same schemas and lifecycle described in [Tool reference](tool-reference.md).

## Error envelope

Lucy error responses use a versioned envelope:

```json
{
  "schema_version": "1",
  "request_id": "req_error",
  "error": {
    "code": "version_conflict",
    "message": "The expected memory version does not match.",
    "retryable": false
  }
}
```

Contract-level error codes:

- `unauthenticated`
- `forbidden`
- `not_found_or_not_visible`
- `invalid_scope`
- `invalid_request`
- `unsupported_version`
- `conflict`
- `version_conflict`
- `rate_limited`
- `payload_too_large`
- `service_unavailable`
- `insufficient_credits`
- `billing_unavailable`

The JavaScript client maps these into typed client errors. Applications should log the error code and bounded request ID rather than an upstream message. See [SDK reference](sdk.md).

## Retries

The built-in HTTP transport retries only `memory_propose` on:

- 429
- 502
- 503
- 504

`memory_recall` and `memory_proposal_status` do not auto-retry those statuses. A lost or ambiguous response after charge would otherwise create a new random billing identity and double-charge.

Propose retry is safe because the proposal `idempotency_key` is sent as `Idempotency-Key`.

Defaults:

- `maxRetries: 2`
- allowed range: 0-5

`Retry-After` is supported as:

- seconds
- an HTTP date

If the header is missing or invalid, the transport does not invent a delay. Valid delays are capped at 60000 ms, and retry waits stop immediately when the request `AbortSignal` is aborted.

Retries do not replace idempotency. Every durable proposal still needs a valid `idempotency_key`.

## Timeout and abort

The `AgentMemoryClient` applies its own timeout:

- default: 10000 ms
- allowed range: 1-300000 ms

When the timeout fires, the AbortSignal passed to the transport is aborted and the client returns a typed timeout error.

## Response validation

The client verifies:

- transport status is an integer HTTP status
- `byteLength` is a non-negative safe integer
- optional `retryAfterMs` is valid
- response body is serializable
- declared byte length is not smaller than canonical body bytes
- raw bodies for every success and error response do not exceed 65536 bytes; the built-in transport enforces this while streaming, before full buffering
- successful body matches the declared schema
- error body matches the error schema

Malformed responses fail closed.

## Programmatic HTTP transport

```ts
import {
  AgentMemoryClient,
  createLucyHttpTransport,
} from '@trylucy/agent-memory';

const transport = createLucyHttpTransport({
  baseUrl: 'https://www.trylucy.ai',
  maxRetries: 2,
});

const client = new AgentMemoryClient({
  transport,
  token: process.env.LUCY_MEMORY_TOKEN!,
  permissions: ['memory:read', 'memory:propose'],
  timeoutMs: 10_000,
});
```

`createLucyHttpTransport` also accepts:

- `fetchImpl` for controlled runtimes and tests; responses must expose `body.getReader()` for bounded streaming
- `sleep` for deterministic retry testing; it receives `(ms, signal)`
- `allowInsecureLoopback: true` for explicit development-only cleartext HTTP to loopback endpoints

HTTPS is required by default. The transport refuses bearer credentials over cleartext HTTP. The only exception is an explicit `allowInsecureLoopback: true` opt-in for `localhost`, IPv4 `127.0.0.0/8`, or IPv6 `::1`; the opt-in never permits a non-loopback HTTP host. For stdio configuration, the equivalent development-only setting is `LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK=true`.

## Custom transport module

Set `LUCY_MEMORY_TRANSPORT_MODULE` instead of `LUCY_MEMORY_BASE_URL`.

The value must be:

- an absolute filesystem path, or
- a `file:` URL

The module must export either `createTransport` or a default factory.

```js
export async function createTransport() {
  return async function transport({
    operation,
    payload,
    accessToken,
    signal,
  }) {
    // Send the request through an authorized transport.
    // Never log accessToken or raw secret-bearing payloads.
    return {
      status: 200,
      body: {},
      byteLength: 2,
    };
  };
}
```

The returned transport function must resolve to:

```ts
{
  status: number;
  body: unknown;
  byteLength: number;
  retryAfterMs?: number;
}
```

Set exactly one transport source. Configuring both or neither fails closed.

## Direct database access is forbidden

The MCP runtime and SDK must not use Supabase or another database as an alternate authority. All governed durable memory flows through Lucy Agent Memory HTTP v1.
