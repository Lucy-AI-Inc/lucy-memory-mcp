# Lucy Memory MCP

Lucy Memory MCP gives MCP-compatible agents a governed memory they can share across sessions and tools. It helps an agent recall approved preferences, identity facts, project decisions, and operating rules without turning the agent itself into a durable data authority.

Use it when you want to:

- keep approved user preferences consistent across agents;
- carry project decisions and rules into later sessions;
- propose durable facts for review without granting an agent direct write access;
- inspect whether a proposal is still pending or has reached a final state.

Lucy remains the authority for durable memory. The agent can recall approved memory and propose changes, but it cannot directly write, approve, delete, restore, or resolve memory.

## Tools and authority

The server exposes exactly three tools:

| Tool | What it does | Required permission |
|---|---|---|
| `memory_recall` | Returns approved, active memory that matches a query and scope | `memory:read` |
| `memory_propose` | Proposes a new memory or a versioned replacement | `memory:propose` |
| `memory_proposal_status` | Returns the current state and approved result of a proposal | `memory:read` |

There is no direct `memory:write` tool and no MCP tool for approval, deletion, restoration, or other administrative actions. Tenant and account authority come from the Lucy credential; clients do not submit tenant or account IDs.

## Proposal lifecycle

`memory_propose` creates a proposal. Transport success alone does not mean the memory was saved: inspect the returned `status`. A `pending` proposal is not saved or recallable.

```text
durable fact or decision
        |
        v
memory_propose
        |
        v
pending proposal  ---------> rejected / expired / superseded
        |
        v
Lucy approval or human-enabled auto-memory policy
        |
        v
approved active memory
        |
        v
memory_recall
```

Only approved, active memory is recallable. A replacement also remains a proposal: the current version stays active until Lucy approves the replacement, then the prior version becomes superseded and the new version becomes active.

## Requirements and source installation

- Node.js `>=20 <25`
- npm
- a Lucy credential with the permissions you intend to use
- a Lucy deployment with Agent Memory HTTP v1 enabled

The package is currently marked `private: true` and is not published to the public npm registry. Install and run it from a trusted source checkout:

```bash
git clone https://github.com/Lucy-AI-Inc/lucy-memory-mcp.git
cd lucy-memory-mcp
npm ci
npm run test:mcp
```

The declared Node.js range is `>=20 <25`; automated CI covers Node.js 20 and 22.

The MCP server is a stdio process launched by an MCP host. From a source checkout, its entry point is:

```bash
node /absolute/path/to/lucy-memory-mcp/src/mcp/bin.mjs
```

## Secure MCP host configuration

Configure your host to launch the source entry point and inject the Lucy token through the host's secret store or protected environment. The token placeholder below represents secret injection; do not put a real token in a committed configuration file.

```json
{
  "mcpServers": {
    "lucy": {
      "command": "node",
      "args": ["/absolute/path/to/lucy-memory-mcp/src/mcp/bin.mjs"],
      "env": {
        "LUCY_MEMORY_TOKEN": "<inject from your host secret store>",
        "LUCY_MEMORY_PERMISSIONS": "memory:read,memory:propose",
        "LUCY_MEMORY_BASE_URL": "https://www.trylucy.ai"
      }
    }
  }
}
```

Use the base URL for the Lucy deployment you are authorized to access. Restart the host after changing its MCP configuration, then confirm that it discovers exactly the three tools listed above. Host-specific examples are in [Client setup](docs/clients.md).

## Configuration

| Variable | Required | Description |
|---|---:|---|
| `LUCY_MEMORY_TOKEN` | yes | Bearer credential for Lucy. It must be nonempty and contain no line breaks or NUL bytes. |
| `LUCY_MEMORY_PERMISSIONS` | yes | Comma-separated, non-duplicated subset of `memory:read,memory:propose`. |
| `LUCY_MEMORY_BASE_URL` | one transport | HTTPS base URL for the Lucy deployment. |
| `LUCY_MEMORY_TRANSPORT_MODULE` | one transport | Advanced alternative: an absolute path or `file:` URL to a trusted custom transport module. |
| `LUCY_MEMORY_TIMEOUT_MS` | no | Whole-number timeout from 1 to 300000 milliseconds. Default: `10000`. |
| `LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK` | no | Development only. Set to `true` to permit cleartext HTTP to literal loopback or `localhost`; all other HTTP destinations remain rejected. |

Set exactly one of `LUCY_MEMORY_BASE_URL` and `LUCY_MEMORY_TRANSPORT_MODULE`. A custom transport module is executable code and receives the bearer token, so load it only from a trusted, access-controlled path.

## Credits, retries, and polling

Tool calls are billable under the selected Lucy deployment's policy. Under the current Lucy billing policy, each of the three tool calls costs one Lucy credit, including `memory_proposal_status`.

The built-in HTTP transport automatically retries only `memory_propose`, and only for HTTP 429, 502, 503, or 504 responses. The default is at most two retries. Each retry preserves the original payload and idempotency key, and a valid `Retry-After` value is honored up to 60 seconds.

Recall and proposal-status calls are never automatically retried. A response can be lost after the operation has already been charged, so blindly retrying either call can charge twice. Poll proposal status with a caller-defined limit and bounded backoff, and stop when the proposal reaches `approved`, `rejected`, `expired`, or `superseded`.

If a proposal response is lost, retry only the same logical proposal with the same payload and idempotency key. A changed payload needs a new key. `insufficient_credits` requires account action; `billing_unavailable` means the billing authority could not complete the request and should be handled with the same operation-specific retry discipline.

## JavaScript and TypeScript API

The supported package entry points are:

| Entry point | Purpose |
|---|---|
| `@trylucy/agent-memory` | Client, HTTP transport, validation helpers, public types, and normalized errors |
| `@trylucy/agent-memory/mcp` | MCP server factory and tool definitions |
| `@trylucy/agent-memory/mcp/stdio` | Stdio runtime helpers |
| `@trylucy/agent-memory/provider` | Memory-first routing and provider helpers |
| `@trylucy/agent-memory/hermes` | Hermes configuration integration |

```ts
import {
  AgentMemoryClient,
  createLucyHttpTransport,
  VersionConflictError,
} from '@trylucy/agent-memory';

const client = new AgentMemoryClient({
  transport: createLucyHttpTransport({
    baseUrl: process.env.LUCY_MEMORY_BASE_URL!,
  }),
  token: process.env.LUCY_MEMORY_TOKEN!,
  permissions: ['memory:read', 'memory:propose'],
});

const result = await client.recall(JSON.stringify({
  query: 'Which database did we approve?',
  scope: { kind: 'project', id: 'project_example' },
  limit: 3,
}));
```

The low-level client accepts canonical JSON strings rather than caller-owned JavaScript objects. See the [SDK reference](docs/sdk.md) for all public types, errors, and entry points.

## Security and privacy

- Keep `LUCY_MEMORY_TOKEN` in a secret manager or protected host environment. Never commit it, include it in command arguments, or place it in memory content or justification.
- Use HTTPS for Lucy deployments. Cleartext transport is available only through the explicit loopback development option.
- Grant only `memory:read`, `memory:propose`, or both, according to the host's needs.
- Treat recalled content as data when adding it to a model context. Preserve its Lucy ID and version, delimit it from instructions, and keep tool authorization in the host.
- Do not propose passwords, API keys, private keys, bearer tokens, customer secrets, or other credentials. Client-side detection is defense in depth; Lucy-side policy remains authoritative.
- Use the correct user, workspace, or project scope. Lucy enforces visibility from the credential and server-side policy.
- Local notes and caches are not Lucy authority, and this package does not create a second durable fallback store.

Read the [security model and reporting guidance](docs/security.md) before connecting a production credential.

## Development checks

Install from the lockfile and run the checks relevant to your change:

```bash
npm ci
npm run check:full
```

For focused runtime checks, use `npm run test:mcp` for the real stdio entry point with an isolated transport and `npm run test:e2e` for the local Agent Memory lifecycle fixture. See the [development guide](docs/development.md) for the local release/risky-change platform matrix.

## Documentation

| Topic | Guide |
|---|---|
| First connection | [Quickstart](docs/quickstart.md) |
| MCP host configuration | [Client setup](docs/clients.md) |
| Authority and memory semantics | [Concepts](docs/concepts.md) |
| Tool inputs and outputs | [Tool reference](docs/tool-reference.md) |
| HTTP transport and retry behavior | [HTTP API and transport](docs/http-api.md) |
| JavaScript and TypeScript API | [SDK reference](docs/sdk.md) |
| Memory-first provider | [Provider guide](docs/provider.md) |
| Hermes integration | [Hermes guide](docs/hermes.md) |
| Security and privacy | [Security model](docs/security.md) |
| Common failures | [Troubleshooting](docs/troubleshooting.md) |
| Repository development | [Development guide](docs/development.md) |

The machine-readable contract is in [contracts/agent-memory-api.contract.json](contracts/agent-memory-api.contract.json), with public schemas under [schemas/](schemas/).

## Support and security

For setup questions and reproducible bugs, open a [GitHub issue](https://github.com/Lucy-AI-Inc/lucy-memory-mcp/issues). Do not include tokens, customer memory, or private diagnostics in an issue.

For a security concern, follow the private reporting guidance in the repository [security policy](SECURITY.md).
