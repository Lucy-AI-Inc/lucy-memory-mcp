# MCP tool reference

Lucy Memory MCP exposes exactly three tools.

## Common rules

- Tool arguments are JSON objects.
- `scope` is an object, never a string: user `{ "kind": "user" }`, workspace `{ "kind": "workspace" }`, project `{ "kind": "project", "id": "<project-id>" }`.
- The package validates against local versioned schemas before using the transport.
- Tenant and account identity are never tool arguments.
- Project access is still enforced by Lucy.
- Pending proposals are not recallable.
- Only the three advertised tools are supported; hosts must reject any other tool name.

## `memory_recall`

Recall approved, active Lucy memory.

### Permission

`memory:read`

### Arguments

```json
{
  "query": "approved project database decision",
  "scope": {
    "kind": "project",
    "id": "project_abc"
  },
  "keys": ["architecture.database"],
  "kinds": ["decision"],
  "limit": 3
}
```

| Field | Required | Rules |
|---|---:|---|
| `query` | yes | Maximum 1024 Unicode scalars |
| `scope` | yes | User, workspace, or project |
| `keys` | no | Maximum 20 keys |
| `kinds` | no | `fact`, `preference`, `decision`, `rule` |
| `limit` | no | 1-5; default 3 |

Request limit: 8192 UTF-8 bytes.

### Response

```json
{
  "schema_version": "1",
  "request_id": "req_abc",
  "as_of": "2026-08-24T12:06:00Z",
  "consistency": "canonical_active",
  "scope": {
    "kind": "project",
    "id": "project_abc"
  },
  "results": [
    {
      "schema_version": "1",
      "id": "mem_123",
      "version": 1,
      "key": "architecture.database",
      "kind": "decision",
      "scope": {
        "kind": "project",
        "id": "project_abc"
      },
      "content": "PostgreSQL is canonical.",
      "status": "active",
      "receipt": {
        "schema_version": "1",
        "id": "rcpt_123_v1",
        "memory_id": "mem_123",
        "memory_version": 1,
        "key": "architecture.database",
        "kind": "decision",
        "scope": {
          "kind": "project",
          "id": "project_abc"
        },
        "lifecycle": "active",
        "authority": {
          "type": "human_approved"
        },
        "authoritative_at": "2026-08-24T12:05:00Z",
        "issued_at": "2026-08-24T12:06:00Z",
        "provenance": {
          "type": "governed_record",
          "ref": "prov_123"
        },
        "relations": []
      }
    }
  ],
  "notices": []
}
```

Response limit: 65536 UTF-8 bytes.

An empty `results` array is successful and does not disclose whether a non-visible record exists.

## `memory_propose`

Create a governed proposal. Success can be pending, approved, rejected, expired, or superseded. It is never a direct write capability.

### Permission

`memory:propose`

### Create arguments

```json
{
  "operation": "create",
  "key": "architecture.database",
  "kind": "decision",
  "scope": {
    "kind": "project",
    "id": "project_abc"
  },
  "content": "PostgreSQL is canonical.",
  "justification": "The project owner approved the decision.",
  "source_ref": "conversation:architecture-review",
  "idempotency_key": "arch-db-20260824-0001"
}
```

Create must not include:

- `memory_id`
- `expected_version`

### Replace arguments

```json
{
  "operation": "replace",
  "memory_id": "mem_123",
  "expected_version": 1,
  "key": "architecture.database",
  "scope": {
    "kind": "project",
    "id": "project_abc"
  },
  "content": "PostgreSQL 18 is canonical.",
  "justification": "The approved architecture decision was updated.",
  "source_ref": "conversation:architecture-review-2",
  "idempotency_key": "arch-db-20260824-0002"
}
```

Replace must not include `kind`. The existing memory kind is retained.

### Proposal field limits

| Field | Limit |
|---|---:|
| Entire request | 12288 UTF-8 bytes |
| `content` | 8192 UTF-8 bytes and 2000 Unicode scalars |
| `justification` | 2048 UTF-8 bytes and 500 Unicode scalars |
| `source_ref` | 256 characters |
| `key` | 128 characters |
| `idempotency_key` | 16-128 characters |

### Pending response

```json
{
  "schema_version": "1",
  "id": "proposal_456",
  "proposal_version": 1,
  "operation": "create",
  "status": "pending",
  "requested": {
    "key": "architecture.database",
    "kind": "decision",
    "scope": {
      "kind": "project",
      "id": "project_abc"
    }
  },
  "relations": [],
  "created_at": "2026-08-24T12:00:00Z",
  "expires_at": "2026-08-31T12:00:00Z",
  "decided_at": null,
  "result": null
}
```

### Approved response

An approved proposal includes:

```json
{
  "status": "approved",
  "result": {
    "memory_id": "mem_123",
    "memory_version": 1,
    "receipt_id": "rcpt_123_v1"
  }
}
```

The full response still includes the common proposal fields.

### Idempotency

- Same idempotency key plus the same canonical payload returns the same authoritative proposal/result.
- Same idempotency key plus changed payload returns a conflict.
- Retries must not create duplicate durable proposals.

## `memory_proposal_status`

Read the current status of a proposal.

### Permission

`memory:read`

Official templates configure both public permissions, so they can recall, propose, and poll status. A read-only client can recall and poll status but cannot create proposals.

### Arguments

```json
{
  "proposal_id": "proposal_456"
}
```

### Response

The response uses the same proposal shape returned by `memory_propose`.

Possible states:

- `pending`
- `approved`
- `rejected`
- `expired`
- `superseded`

A not-found response is normalized so callers cannot distinguish absent records from records they are not authorized to see.

## Forbidden capabilities

These are not aliases and must not be added by a host:

- `memory_list`
- `memory_resolve`
- `memory_approve`
- `memory_reject`
- `memory_delete`
- `memory_restore`

Human approval, rejection, forgetting, and restoration remain Lucy-side actions.
