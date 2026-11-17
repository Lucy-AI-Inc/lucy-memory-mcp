# Hosted MCP on Vercel

Deploy this repository as the separate Vercel project `lucy-memory-mcp`, connected to `Lucy-AI-Inc/lucy-memory-mcp`. This is a staging/private-beta service, not a route in the Lucy Next.js project. Source configuration fixes `iad1`, 2 GB memory, and a 60-second function limit. In Vercel project settings, also enable Fluid compute and verify those three values after deployment.

## Environment contract

Copy names—not values—from `.env.vercel.example`. Store secret values in Vercel and never in source, build logs, or evidence.

| Variable | Requirement | Secret | Rule |
|---|---|---:|---|
| `HOSTED_MCP_ENABLED` | required | no | Only exact `true` enables `POST /mcp`; default off. |
| `HOSTED_MCP_CANONICAL_URL` | required | no | Intended value `https://mcp.trylucy.ai/mcp`; OAuth audience and resource. |
| `HOSTED_MCP_PRODUCT_BASE_URL` | required | no | HTTPS PRODUCT staging origin only. |
| `HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL` | required | yes | Distinct 32+ byte service credential; no whitespace or comma. |
| `HOSTED_MCP_OAUTH_ISSUER` | OAuth | no | Brian-selected provider issuer. |
| `HOSTED_MCP_OAUTH_JWKS_URL` | OAuth | no | Provider JWKS URL. |
| `HOSTED_MCP_OAUTH_INTROSPECTION_URL` | OAuth | no | RFC 7662 endpoint; revocation check is mandatory/fail-closed. |
| `HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION` | OAuth | yes | Complete provider Authorization header value. |
| `HOSTED_MCP_LOG_HASH_KEY` | required | yes | Distinct 32+ byte HMAC key. |
| `HOSTED_MCP_ALLOWED_ORIGINS` | optional | no | Comma-separated exact origins; an absent Origin is allowed. |
| `HOSTED_MCP_AUTH_MODE` | optional | no | `oauth` by default. The guarded static mode is preview/development only and cannot coexist with OAuth configuration. |
| `HOSTED_MCP_CALL_TIMEOUT_MS` | optional | no | `1000..55000`; default `55000`. |
| `HOSTED_MCP_STAGING_STATIC_BEARER` | static mode only | yes | Nonempty preview-only bearer; must differ from every service/log credential. |
| `HOSTED_MCP_STAGING_STATIC_SUBJECT` | static mode only | no | Disposable user UUID installed by the server operator. |
| `HOSTED_MCP_STAGING_STATIC_WORKSPACE_ID` | static mode only | no | Disposable workspace UUID installed by the server operator. |
| `HOSTED_MCP_STAGING_STATIC_SCOPES` | static mode only | no | Duplicate-free `memory:read` and/or `memory:propose`. |
| `HOSTED_MCP_ALLOW_INSECURE_LOOPBACK` | local harness only | no | Never enable in Vercel; only explicit loopback HTTP development. |

Do not add Supabase keys, database URLs, chat secrets, billing credentials, customer API keys, or long-lived Agent Memory tokens to this project.

## Edge and spend controls

An operator must configure these in Vercel; application code and the local harness do not create them:

- Firewall rule on `/mcp`: 300 requests per 5 minutes per source IP.
- Spend management: hard stop at 1,000,000 application requests per month.
- Compute-spend notification at $25 per month.
- Custom domain and TLS for `mcp.trylucy.ai`; route the canonical resource to `/mcp` and verify both protected-resource metadata paths.

PRODUCT enforces shared Postgres admission separately: 50 global concurrent upstream calls, plus 5 concurrent and 120 per 5 minutes for subject/workspace/operation scope. Do not recreate those limits in process memory or at the edge.

## Deploy and verify

1. Create/link `lucy-memory-mcp`, select staging/private-beta access, enable Fluid compute, install the environment contract, and leave `HOSTED_MCP_ENABLED=false`.
2. Deploy the reviewed SHA. Confirm `GET /healthz` reports disabled, both OAuth metadata URLs are identical, and `GET /mcp` is 405 with `Allow: POST`.
3. Confirm PRODUCT's independent `HOSTED_MCP_PRODUCT_ENABLED` switch and the single migration `supabase/migrations/20261116070100_hosted_mcp_admission.sql` are ready.
4. Enable PRODUCT first, then set MCP `HOSTED_MCP_ENABLED=true`. Confirm health, OAuth revocation, all three tools, shared limits, log redaction, and ordinary chat health with disposable staging identities.
5. Capture deployment SHA/digest, project settings, firewall/spend/DNS evidence, sampled redacted logs, and two-instance global-cap evidence. Local evidence never substitutes for these hosted checks.

The MCP-side emergency switch is `HOSTED_MCP_ENABLED=false`. The independent PRODUCT switch is `HOSTED_MCP_PRODUCT_ENABLED=false`; either stops hosted calls without disabling PRODUCT health or chat. For a code rollback, use Vercel Instant Rollback to the last certified deployment, keep the MCP switch off until checks pass, and rotate the service credential if compromise is suspected. Credential rotation order is PRODUCT current/previous, MCP new value, then removal of PRODUCT previous after old instances drain.
