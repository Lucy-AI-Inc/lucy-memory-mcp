# Concepts and lifecycle

Lucy Memory MCP separates an application's decision to use memory from Lucy's decision to make information durable.

The MCP server validates and transports requests. Lucy remains the canonical governed memory service.

## Behavior guarantees

- A proposal is not saved memory until Lucy approves it.
- Normal recall returns approved, active memory.
- Local notes and session state do not become canonical memory.
- The integration does not silently write a second durable copy.
- An unavailable Lucy service does not cause a local durable fallback.

## Public tools and permissions

| Tool | Permission | Purpose |
|---|---|---|
| `memory_recall` | `memory:read` | Recall approved active memory |
| `memory_propose` | `memory:propose` | Propose a create or replacement |
| `memory_proposal_status` | `memory:read` | Read a proposal's current state |

The MCP server has no approval, deletion, restoration, or administrative tool.

## Memory kinds

| Kind | Use |
|---|---|
| `fact` | Stable identity, background, or factual context |
| `preference` | A durable user preference |
| `decision` | A project or operating decision |
| `rule` | A standing governed rule |

A memory cannot grant credentials, spending authority, deployment authority, tenant access, or a policy exemption.

## Scopes

User scope:

```json
{ "kind": "user" }
```

Workspace scope:

```json
{ "kind": "workspace" }
```

Project scope:

```json
{
  "kind": "project",
  "id": "project_abc"
}
```

The credential determines the caller's tenant and account authority. A project selector is accepted only when Lucy authorizes access to that project.

## Proposal lifecycle

```text
pending
  |-- approved
  |-- rejected
  |-- expired
  +-- superseded
```

Proposal states are terminal after they leave `pending`.

With the default policy, a person reviews the proposal in Lucy. If an administrator enables auto memory, Lucy may apply that policy immediately. The MCP client still only proposes.

## Memory lifecycle

```text
active
  |-- superseded
  |-- revoked
  +-- forgotten
```

Normal recall returns `active` memory with `consistency: "canonical_active"`.

## Create

A create proposal introduces memory under a key and scope. It includes:

- `operation: "create"`
- `key`
- `kind`
- `scope`
- `content`
- `justification`
- `idempotency_key`

Lucy prevents more than one active memory for the same tenant, scope, and key.

## Replace

A replacement keeps the same memory identity and creates a new version. It includes:

- `operation: "replace"`
- `memory_id`
- `expected_version`
- `key` and `scope`
- `content` and `justification`
- `idempotency_key`

The key, kind, and scope cannot change. If `expected_version` is stale, Lucy returns `version_conflict`.

## Receipts

Approved active memory includes a version-specific receipt with the memory ID, version, scope, lifecycle, timestamp, and governed provenance. A receipt describes that version. Perform a new recall when you need the current active state.

## What remains local

Use local state for session transcripts, drafts, machine paths, procedural instructions, and short-lived work. When local state references Lucy memory, keep its memory ID and version so the provenance remains clear.
