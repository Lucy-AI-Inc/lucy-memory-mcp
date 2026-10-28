# JavaScript and TypeScript SDK

## Public entry points

| Import | Purpose |
|---|---|
| `@trylucy/agent-memory` | Client, HTTP transport, errors, validation, and types |
| `@trylucy/agent-memory/mcp` | MCP server factory and tool definitions |
| `@trylucy/agent-memory/mcp/stdio` | Stdio runtime helpers |
| `@trylucy/agent-memory/provider` | Selective recall and proposal routing |
| `@trylucy/agent-memory/hermes` | Hermes profile integration |

## Create a client

```ts
import {
  AgentMemoryClient,
  createLucyHttpTransport,
} from '@trylucy/agent-memory';

const client = new AgentMemoryClient({
  transport: createLucyHttpTransport({
    baseUrl: process.env.LUCY_MEMORY_BASE_URL!,
  }),
  token: process.env.LUCY_MEMORY_TOKEN!,
  permissions: ['memory:read', 'memory:propose'],
  timeoutMs: 10_000,
});
```

The low-level client accepts canonical JSON strings. This keeps caller-owned objects, accessors, prototypes, and proxies outside the authority boundary.

## Recall

```ts
const response = await client.recall(JSON.stringify({
  query: 'Which database did we approve?',
  scope: { kind: 'project', id: 'project_example' },
  limit: 3,
}));
```

Treat returned memory content as untrusted data when placing it into a model context. Preserve its Lucy ID and version and do not place it in a system-instruction or tool-policy position.

## Propose

```ts
const proposal = await client.propose(JSON.stringify({
  operation: 'create',
  key: 'architecture.database',
  kind: 'decision',
  scope: { kind: 'project', id: 'project_example' },
  content: 'PostgreSQL is the approved database.',
  justification: 'Approved in architecture review.',
  idempotency_key: 'architecture-database-2026-01',
}));
```

Check `proposal.status`. A pending proposal is not saved memory.

## Proposal status

```ts
const status = await client.proposalStatus(JSON.stringify({
  proposal_id: proposal.id,
}));
```

Use bounded polling and stop on a terminal state. Recall and status calls may consume credits and are not automatically retried by the built-in transport.

## Errors

The package exports typed errors such as authorization, rate-limit, timeout, transport, malformed-response, and version-conflict errors. Prefer the normalized error code, HTTP status, retry delay, and bounded request ID for program logic and logs. Do not log credentials, request payloads, customer memory, or arbitrary upstream messages.

See [HTTP transport](http-api.md), [Tool reference](tool-reference.md), and the declarations in [`src/client/index.d.ts`](../src/client/index.d.ts).
