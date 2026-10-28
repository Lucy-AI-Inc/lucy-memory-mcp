# Recovery and retry behavior

Lucy Memory MCP does not create a local durable fallback. Recovery uses Lucy proposal IDs, idempotency keys, and a fresh recall of authoritative state.

## Lost proposal response

If a proposal request may have reached Lucy but the response was lost, retry the same logical proposal with the same canonical payload and idempotency key. Changing the payload requires a new key.

If you retained the proposal ID, call `memory_proposal_status` instead of creating another proposal.

## Pending proposal

Pending means the proposal has not become recallable memory. Poll with a caller-defined limit and bounded backoff. Stop when it reaches a terminal state.

## Version conflict

For a replacement that returns `version_conflict`:

1. recall the current active memory;
2. inspect its ID, version, scope, and content;
3. decide whether the replacement is still correct;
4. submit a new proposal with the current `expected_version` and a new idempotency key.

Do not blindly retry a stale replacement.

## Timeout or unavailable service

Keep temporary work in session state and retry according to your application's policy. Do not label local content as canonical Lucy memory. Recall and status are not automatically retried by the built-in transport because an ambiguous response may already have consumed a credit.

## Host restart

The MCP server is stateless. After a host restart, launch it with the same protected configuration. Proposal IDs and temporary UI state belong to the host; durable approved memory remains in Lucy.

## Credential loss or exposure

Revoke the credential in Lucy, remove it from client configuration and logs, issue a replacement, and restart the host. Do not store replacement credentials in memory proposals.
