# MCP client setup

Lucy Memory MCP runs as a stdio process. Every supported host launches the same command, passes configuration through protected environment variables, and should discover exactly these tools:

- `memory_recall`
- `memory_propose`
- `memory_proposal_status`

Hosted MCP deployments must not use the stdio credential flow below. They must exchange the validated client identity for a separate, short-lived Lucy credential as described in [Hosted credential exchange](#hosted-credential-exchange).

## Before you begin

You need a trusted checkout, Node.js `>=20 <25`, and a Lucy credential for the permissions you intend to use.

Keep `LUCY_MEMORY_TOKEN` in the host's secret store or protected process environment. Do not commit it to a client configuration file.

## Source-checkout command

```json
{
  "command": "node",
  "args": ["/absolute/path/to/lucy-memory-mcp/src/mcp/bin.mjs"]
}
```

When the npm package becomes available, hosts can use `lucy-memory-mcp` as the command instead.

## Generic MCP configuration

```json
{
  "mcpServers": {
    "lucy": {
      "command": "node",
      "args": ["/absolute/path/to/lucy-memory-mcp/src/mcp/bin.mjs"],
      "env": {
        "LUCY_MEMORY_TOKEN": "<inject from your secret store>",
        "LUCY_MEMORY_PERMISSIONS": "memory:read,memory:propose",
        "LUCY_MEMORY_BASE_URL": "https://www.trylucy.ai"
      }
    }
  }
}
```

Use the base URL for the Lucy environment your credential belongs to. Restart the host after changing its MCP configuration.

## Host templates

Checked-in examples are available for:

- [Generic MCP](../src/clients/generic.mcp.json)
- [Claude Desktop](../src/clients/claude-desktop.json)
- [Claude Code](../src/clients/claude.json)
- [Codex](../src/clients/codex.toml)
- [Cursor](../src/clients/cursor.json)
- [VS Code](../src/clients/vscode.json)
- [OpenClaw](../src/clients/openclaw.json)

Merge the Lucy entry into the host's existing configuration. Preserve unrelated servers and settings. Host configuration formats and paths can change between releases, so consult the host's current documentation when an example no longer matches.

## Memory-first behavior adapters

The canonical, vendor-neutral instructions are in [`.github/skills/lucy-memory-first/SKILL.md`](../.github/skills/lucy-memory-first/SKILL.md). Use that file directly; do not fork its content per host.

| Host | Adapter |
|---|---|
| GitHub Copilot | Copy the `lucy-memory-first` directory into the repository's `.github/skills/` directory. This repository is already installed correctly. |
| Grok | Paste the canonical `SKILL.md` body into the Grok workspace or agent custom instructions. Keep the title and rules; YAML front matter may be omitted when the field accepts plain instructions only. |
| Hermes | Install the Lucy MCP entry with `installHermesLucyConfig`. Lucy surfaces the canonical skill as MCP server `instructions`; if the Hermes deployment has a native skills directory, install the same `lucy-memory-first` directory there as well. |
| Generic instruction-only host | Paste the canonical `SKILL.md` body into persistent project instructions. YAML front matter may be omitted. |

The npm package includes the canonical file at `node_modules/@trylucy/agent-memory/.github/skills/lucy-memory-first/SKILL.md`, so adapters can copy it without fetching a second source.

## Verify setup

Verify the two layers independently.

### 1. MCP connected

1. Confirm the command resolves and starts.
2. Confirm exactly the three Lucy tools above are discovered.
3. Run a safe recall. An empty result is valid.
4. Submit a non-sensitive proposal and inspect its status.
5. Confirm a pending proposal is not described as saved.

### 2. Memory-first behavior installed

1. Confirm the host loaded the canonical `lucy-memory-first` skill or instructions.
2. Ask the host when it should recall Lucy memory.
3. Confirm it describes selective recall for durable context, not every prompt.
4. Confirm it treats proposals as human-governed and pending proposals as not saved.

Tool discovery does not prove the behavior layer is installed, and loading instructions does not prove the MCP process can connect.

## Recall search guidance

`scope` is an object, never a string:

- user: `{ "kind": "user" }`
- workspace: `{ "kind": "workspace" }`
- project: `{ "kind": "project", "id": "<project-id>" }`

Minimal valid request: `{ "query": "database", "scope": { "kind": "user" } }`.

- Start with concise literal and distinctive substrings.
- Try spelling and spacing variants when phrasing may have changed.
- Supply known keys, kinds, and scopes when available.
- Broaden or narrow the query and filters iteratively.
- Do not conclude that memory is absent after one empty result.
- Distinguish a successful zero-match response from authentication, authorization, rate-limit, timeout, and service errors.

Never paste a credential into a tool argument, memory, justification, log, issue, or diagnostic bundle.

## Hosted credential exchange

After the hosted MCP resource server validates the client's OAuth bearer, call `createHostedAgentMemoryClient` with that trusted server auth context. Do not construct the context from request JSON, headers, query parameters, or unvalidated token claims.

```js
const client = await createHostedAgentMemoryClient({
  authContext: {
    subject: validatedAuth.subject,
    workspaceId: validatedAuth.workspaceId,
    scopes: validatedAuth.scopes,
  },
  exchangeUrl: process.env.LUCY_CREDENTIAL_EXCHANGE_URL,
  serviceToken: process.env.LUCY_CREDENTIAL_EXCHANGE_SERVICE_TOKEN,
  transport: createLucyHttpTransport({ baseUrl: process.env.LUCY_MEMORY_BASE_URL }),
});
```

The factory sends this HTTPS request using the server-to-server service token, never the client bearer:

```http
POST <LUCY_CREDENTIAL_EXCHANGE_URL>
Authorization: Bearer <server service credential>
Content-Type: application/json

{
  "subject": "<validated OAuth subject>",
  "workspace_id": "<validated workspace>",
  "scopes": ["memory:read", "memory:propose"]
}
```

Only validated `memory:read` and `memory:propose` scopes are requested. The frontend/exchange counterpart must independently authorize the subject and workspace, mint a short-lived credential limited to those requested scopes, and return:

```json
{
  "access_token": "<short-lived Lucy credential>",
  "token_type": "Bearer",
  "expires_at": "2026-08-23T00:05:00.000Z",
  "scopes": ["memory:read", "memory:propose"]
}
```

The returned scopes may be a nonempty subset of the request and must not include any other permission. `expires_at` must be in the future and no more than 15 minutes from exchange. The exchanged token must differ from the exchange service credential. Any network error, non-2xx response, malformed/expired/over-scoped response, non-short-lived credential, or equal token fails closed before `AgentMemoryClient` can call Agent Memory. The resource server must keep the client bearer inside its authentication boundary and prove there that it never reaches this bearer-free hosted-client seam or Agent Memory upstream.

## Disconnect

Remove the Lucy server entry from the host and revoke the credential in Lucy. For Hermes, use the package's uninstall helper so unrelated YAML configuration is preserved.

See [Quickstart](quickstart.md), [Troubleshooting](troubleshooting.md), and [Security](security.md).
