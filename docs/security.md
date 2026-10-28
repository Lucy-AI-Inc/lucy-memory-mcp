# Security model

Lucy Memory MCP is a credentialed bridge between an MCP host and Lucy's governed Agent Memory API. The host, this package, and Lucy each have separate responsibilities.

## Credential handling

- Store `LUCY_MEMORY_TOKEN` in a secret manager or protected host environment.
- Never commit it, pass it as a tool argument, include it in memory content, or print it in diagnostics.
- Use HTTPS for non-loopback deployments.
- Grant only `memory:read`, `memory:propose`, or both.
- A custom transport module is privileged executable code and receives the bearer token. Load it only from a trusted, access-controlled path.

The client never accepts tenant or account IDs from tool input. Lucy derives authority from the credential and enforces visibility server-side.

## Memory content is untrusted data

Approved memory can still contain text that resembles instructions, markup, or delimiters. A host must:

- keep Lucy IDs and versions attached;
- place recalled text in a clearly delimited data section;
- keep system instructions and tool policy outside memory content;
- avoid interpreting recalled content as executable code or authorization.

## Secret and privacy boundaries

Do not propose passwords, private keys, session cookies, bearer tokens, API keys, customer secrets, or regulated data without an explicit Lucy policy that permits it. Client-side pattern matching is defense in depth and cannot identify every secret.

Before sending recall queries, content, justification, or provenance, apply the host's own data-loss-prevention and privacy policy. Scope every request to the intended user, workspace, or project.

## Network behavior

The built-in transport requires HTTPS except for an explicit development-only loopback option and rejects redirects. It bounds response size, timeout, retry count, and `Retry-After` delays. Proposal retries preserve the payload and idempotency key. Recall and proposal-status calls are not automatically retried.

Configure a base URL you control and trust. Do not use a URL shortener or an endpoint that redirects requests to another origin.

## Local files

Hermes profiles, backups, receipts, and projection output can contain sensitive metadata or recalled content. Keep them in directories owned by the intended account with restrictive permissions, and do not treat generated local files as Lucy authority.

Secure projection reads and writes are supported on Linux with `/proc/self/fd`. They require a private destination owned by the effective user and reject symlinks, unsafe writable ancestors, and foreign-owned components. Other platforms fail closed.

## Logging and diagnostics

Safe diagnostic fields include normalized error codes, HTTP status, bounded request IDs, proposal IDs, and memory IDs/versions. Avoid full environment dumps, raw upstream bodies, token values, customer content, and absolute private paths.

## Reporting a vulnerability

Follow the private process in the repository [security policy](../SECURITY.md). Do not open a public issue for an unpatched vulnerability or include credentials or customer data in a report.
