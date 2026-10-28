# Development guide

## Prerequisites

- Node.js `>=20 <25`
- npm
- Git

Install the exact dependency graph:

```bash
npm ci --ignore-scripts
```

The package does not require a database or resident service for its local test suite. Some end-to-end tests start loopback servers and child stdio processes.

## Verification

```bash
npm test
npm run test:mcp
npm run test:e2e
npm run test:types
npm run test:package
npm run validate
npm run verify:hashes
npm run scan:secrets
npm audit --audit-level=moderate
npm pack --dry-run
```

On POSIX systems, run permission-sensitive tests with a conventional `0022` umask:

```bash
(umask 022; npm test)
```

## Contract changes

The machine-readable contract and schemas define public behavior. A contract change may require updates to:

- `contracts/agent-memory-api.contract.json`
- schemas under `schemas/`
- declarations under `src/client/`
- validation and MCP schemas
- fixtures, tests, hashes, and documentation

Regenerate and verify hashes after an intentional contract change:

```bash
npm run hashes
npm run validate
npm run verify:hashes
```

The server must continue to expose only `memory_recall`, `memory_propose`, and `memory_proposal_status`, with `memory:read` and `memory:propose` as its only permissions.

## Public package boundaries

Supported import paths are:

- `@trylucy/agent-memory`
- `@trylucy/agent-memory/mcp`
- `@trylucy/agent-memory/mcp/stdio`
- `@trylucy/agent-memory/provider`
- `@trylucy/agent-memory/hermes`

Do not rely on unexported source files from an installed package.

## Publishing

The tag-only release workflow builds and tests a tarball in an unprivileged job, records its SHA-256 digest, and transfers that exact artifact to the protected `npm` environment. The publish job has only OIDC authority and rechecks the digest before using npm trusted publishing with provenance.

Before the first public release, repository owners must select and add the approved license, deliberately set `private` to `false`, protect the `npm` environment, and configure the npm trusted publisher for this repository, `release.yml`, and the `npm` environment. A release tag must exactly match `v<package version>` and point to a commit reachable from `main`.

## Contributions

Keep changes focused, add tests for behavior and security boundaries, and update public documentation when an API or configuration changes. Do not commit credentials, customer memory, local profiles, generated evidence, archives, or diagnostic logs.
