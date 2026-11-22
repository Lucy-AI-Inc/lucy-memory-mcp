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

## 3. Install the memory-first behavior

Connecting MCP exposes tools; it does not guarantee that the host will use them proactively. Install or surface the canonical [Lucy memory-first skill](../.github/skills/lucy-memory-first/SKILL.md) using the adapter for your host:

- **GitHub Copilot:** persist the exact packaged skill bytes in the repository:

  ```js
  import { installCopilotRepositorySkill } from '@trylucy/agent-memory/onboarding';

  installCopilotRepositorySkill(process.cwd());
  ```

  The helper writes `.github/skills/lucy-memory-first/SKILL.md` beneath the repository root and is safe to rerun after package updates.
- **Grok:** add the canonical skill body to the workspace or agent custom instructions.
- **Hermes:** the MCP server surfaces the canonical skill through its MCP `instructions`; also add the same file through Hermes' supported skill mechanism when proactive behavior must not depend on MCP-instruction support.
- **Instruction-only hosts:** copy the canonical skill body into the host's persistent project instructions.

Do not maintain a host-specific rewrite. Every Lucy tool schema also includes guidance derived from the canonical skill for clients that ignore initialization instructions. After installing or updating either layer, fully quit and relaunch the host application. Opening a new conversation in the existing process is not sufficient. See [Client setup](clients.md#memory-first-behavior-adapters) for exact adapters.

## 4. Verify MCP connectivity

Cold-restart the host process and confirm it discovers exactly:

- `memory_recall`
- `memory_propose`
- `memory_proposal_status`

Run a safe `memory_recall`. An empty result is successful and proves connectivity.

## 5. Verify memory-first behavior

Confirm the host has loaded the canonical skill independently of MCP discovery. Ask it when Lucy should be recalled and verify its answer reflects selective recall, human-governed proposals, and the rule that pending proposals are not saved memory.

These are two separate setup checks: **MCP connected** and **memory-first behavior installed**. Passing one does not imply the other.

## 6. Recall approved memory

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

## 7. Propose memory

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
  "idempotency_key": "123e4567-e89b-42d3-a456-426614174001"
}
```

A `pending` response is not saved memory. Lucy must approve the proposal, or apply an administrator-enabled auto-memory policy, before normal recall can return it.

## 8. Check status

Use `memory_proposal_status` with the returned proposal ID. Poll with bounded backoff and stop at `approved`, `rejected`, `expired`, or `superseded`; status calls can consume credits.

Read [Concepts](concepts.md), [Tool reference](tool-reference.md), and [Security](security.md) before production use.
