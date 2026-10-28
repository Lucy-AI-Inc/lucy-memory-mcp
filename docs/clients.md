# MCP client setup

Lucy Memory MCP runs as a stdio process. Every supported host launches the same command, passes configuration through protected environment variables, and should discover exactly these tools:

- `memory_recall`
- `memory_propose`
- `memory_proposal_status`

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

## Verify the connection

1. Confirm the command resolves and starts.
2. Confirm exactly the three Lucy tools above are discovered.
3. Run a safe recall. An empty result is valid.
4. Submit a non-sensitive proposal and inspect its status.
5. Confirm a pending proposal is not described as saved.

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

## Disconnect

Remove the Lucy server entry from the host and revoke the credential in Lucy. For Hermes, use the package's uninstall helper so unrelated YAML configuration is preserved.

See [Quickstart](quickstart.md), [Troubleshooting](troubleshooting.md), and [Security](security.md).
