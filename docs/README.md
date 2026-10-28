# Lucy Memory MCP documentation

Lucy Memory MCP connects MCP-compatible applications to Lucy's governed memory service. Start with the quickstart, then use the reference that matches your integration.

## Get started

1. [Quickstart](quickstart.md)
2. [Client setup](clients.md)
3. [Troubleshooting](troubleshooting.md)

## Understand the model

- [Concepts and lifecycle](concepts.md)
- [Architecture and trust boundaries](architecture.md)
- [MCP tool reference](tool-reference.md)
- [Proposal recovery](recovery.md)

## Build an integration

- [SDK reference](sdk.md)
- [HTTP transport](http-api.md)
- [Memory-first provider](provider.md)
- [Hermes integration](hermes.md)

## Develop and secure the package

- [Development guide](development.md)
- [Security model](security.md)
- [Security reporting policy](../SECURITY.md)

## Contract sources

The prose documentation explains the package, while these tracked artifacts define its exact data contract:

- [Agent Memory API contract](../contracts/agent-memory-api.contract.json)
- [Agent manifest](../contracts/agent-manifest.json)
- [JSON schemas](../schemas/)
- [Fixtures](../fixtures/)
- [Public TypeScript declarations](../src/client/index.d.ts)

The public MCP surface contains exactly three tools:

- `memory_recall`
- `memory_propose`
- `memory_proposal_status`

It uses two permissions: `memory:read` and `memory:propose`.
