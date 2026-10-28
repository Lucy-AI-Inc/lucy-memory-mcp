# Architecture and trust boundaries

Lucy Memory MCP is a stateless stdio server in front of Lucy's Agent Memory HTTP API.

```text
MCP host
  -> Lucy Memory MCP over stdio
  -> AgentMemoryClient
  -> HTTPS transport
  -> Lucy Agent Memory HTTP v1
  -> governed memory
```

## Components

### MCP server

The server:

- exposes `memory_recall`, `memory_propose`, and `memory_proposal_status`
- validates tool input and output against the package schemas
- advertises only the three supported memory tools
- maps client failures to bounded, safe MCP errors
- keeps stdout reserved for MCP protocol frames

The stdio runtime supports MCP `2026-07-28` and compatibility with `2025-11-25`. Both protocol versions expose the same three tools.

### Client

`AgentMemoryClient`:

- checks the configured `memory:read` and `memory:propose` permissions
- accepts canonical JSON request strings
- enforces request, response, and timeout limits
- validates transport metadata and Lucy responses
- returns typed errors

### HTTP transport

The built-in transport:

- uses bearer authentication over HTTPS
- sends `Idempotency-Key` for proposals
- applies bounded retries only to proposal requests
- honors valid `Retry-After` values
- streams responses with a size limit

Recall and proposal-status requests are not automatically retried after ambiguous HTTP failures because each operation may consume Lucy credits.

### Lucy

Lucy remains responsible for:

- deriving tenant, account, actor, user, and workspace authority from the credential
- enforcing project visibility
- storing and deciding proposals
- applying human approval and auto-memory policy
- maintaining memory lifecycle and versions
- issuing receipts

The client never sends a tenant or account ID.

## Request flows

Recall:

```text
host -> memory_recall -> validate -> POST /recall
     <- active governed memory <- validate <-
```

Proposal:

```text
host -> memory_propose -> validate -> POST /proposals
     <- pending or terminal proposal status <-

host -> memory_proposal_status -> GET /proposals/{proposal_id}
```

A pending proposal is not recallable memory. Once Lucy approves it, recall can return the active memory and its receipt.

## Trust boundaries

### Credential

The host supplies `LUCY_MEMORY_TOKEN` to the server process. Tool arguments cannot replace the credential or select a tenant.

### Permissions

The runtime accepts only `memory:read` and `memory:propose`. Missing permissions fail before the transport sends a request.

### Durable writes

The MCP server can propose a create or replacement. It cannot approve, reject, delete, restore, or otherwise decide a proposal.

### Local state

The package is stateless between processes. Hosts may retain proposal identifiers and temporary session state, but local state does not become canonical Lucy memory.

## Failure behavior

| Failure | Result |
|---|---|
| Missing or invalid configuration | Startup fails with a bounded lifecycle error |
| Missing permission | Authorization failure before transport |
| Timeout or unavailable service | Typed failure; no local durable fallback |
| Malformed or oversized response | Rejected before the caller receives it |
| Unsupported MCP tool | The host must reject it as outside the advertised tool surface |
| Token in an upstream message | Replaced by a safe normalized error |
| Pending proposal | Returned as pending, never as saved |
