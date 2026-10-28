# Quickstart

This guide connects an MCP host to Lucy Memory MCP from a source checkout.

## 1. Install

```bash
git clone https://github.com/Lucy-AI-Inc/lucy-memory-mcp.git
cd lucy-memory-mcp
npm ci --ignore-scripts
npm run test:mcp
```

Requirements are Node.js `>=20 <25`, a Lucy credential, and a Lucy environment with Agent Memory HTTP v1 enabled.

## 2. Configure the host

```json
{
  "mcpServers": {
    "lucy": {
      "command": "node",
      "args": ["/absolute/path/to/lucy-memory-mcp/src/mcp/bin.mjs"],
      "env": {
        "LUCY_MEMORY_TOKEN": "<inject securely>",
        "LUCY_MEMORY_PERMISSIONS": "memory:read,memory:propose",
        "LUCY_MEMORY_BASE_URL": "https://www.trylucy.ai"
      }
    }
  }
}
```

Use the host's secret store or protected environment for the token. Never commit a real value. See [Client setup](clients.md) for host-specific templates.

## 3. Verify discovery

Restart the host and confirm it discovers exactly:

- `memory_recall`
- `memory_propose`
- `memory_proposal_status`

## 4. Recall approved memory

Call `memory_recall`:

```json
{
  "query": "Which project database decision has been approved?",
  "scope": { "kind": "project", "id": "project_example" },
  "keys": ["architecture.database"],
  "limit": 3
}
```

An empty result is successful and means no visible active memory matched.

## 5. Propose memory

Call `memory_propose` with durable, non-sensitive information:

```json
{
  "operation": "create",
  "key": "architecture.database",
  "kind": "decision",
  "scope": { "kind": "project", "id": "project_example" },
  "content": "PostgreSQL is the approved project database.",
  "justification": "The project owner approved the decision.",
  "source_ref": "conversation:architecture-review",
  "idempotency_key": "architecture-database-2026-01"
}
```

A `pending` response is not saved memory. Lucy must approve the proposal, or apply an administrator-enabled auto-memory policy, before normal recall can return it.

## 6. Check status

Use `memory_proposal_status` with the returned proposal ID. Poll with bounded backoff and stop at `approved`, `rejected`, `expired`, or `superseded`; status calls can consume credits.

Read [Concepts](concepts.md), [Tool reference](tool-reference.md), and [Security](security.md) before production use.
