# Private-beta certification

## LUC-1078 hosted Vercel checklist

The current lane provides local source evidence for the following items:

- [x] Separate framework-less Vercel function configuration: `iad1`, 2 GB, 60 seconds, with POST-only `/mcp`, `/healthz`, and both RFC 9728 metadata routes.
- [x] Fresh web-standard Streamable HTTP server and transport per request, sharing the existing three-tool core with stdio and Node HTTP.
- [x] RS256/ES256 JWT verification, exact audience/resource/workspace binding, mandatory fail-closed introspection, scope challenges, and guarded non-production static mode.
- [x] One-scope PRODUCT credential exchange, shared global/per-scope admission acquisition, release in `finally`, 8 KiB raw-body limit, 55-second internal deadline, and stable HTTP errors.
- [x] No client-token passthrough and privacy-safe terminal logs with HMAC-hashed subject/workspace identifiers.
- [x] Operator-only Vercel/DNS/firewall/spend controls are documented without runtime mutation code.
- [x] Disposable local E2E entry point and TEST-ONLY OAuth stand-in are excluded from the Vercel bundle.

These items still require hosted/operator inputs and are not proven by local tests:

- [ ] Brian selects and approves the managed OAuth provider and supplies its issuer, JWKS, introspection, revocation, claims, client, and redirect details.
- [ ] An operator creates/links the separate `lucy-memory-mcp` Vercel project, enables Fluid compute, installs secrets, and records the deployed SHA/settings.
- [ ] DNS/TLS provisions `mcp.trylucy.ai`; both metadata paths and the canonical `/mcp` resource are verified over HTTPS.
- [ ] Vercel Firewall 300/5 minutes/IP, the 1,000,000 request/month hard stop, and the $25/month compute alert are configured and evidenced.
- [ ] Brian/Josh apply and verify the single PRODUCT admission migration in the protected staging database.
- [ ] Hosted two-instance evidence proves the shared global 50 cap, lease expiry/recovery, independent kill switches, and unaffected real chat.
- [ ] Hosted provider revocation, sampled redacted logs, staging billing compatibility, rollback, and disposable-account cleanup are captured for go/no-go.

Run the disposable cross-repository proof outside the restricted sandbox with Docker and network access:

```sh
HMCP_PRODUCT_WT=/absolute/path/to/lucy_ai_frontend_nextjs \
HMCP_EVIDENCE_DIR=/absolute/path/to/evidence \
node scripts/e2e/hosted-local.mjs
```

Run the local/mock certification from a trusted checkout:

```sh
npm run cert:private-beta
```

The command writes `.tmp/private-beta/evidence.json` and `.tmp/private-beta/evidence.md`. It exercises the real stdio MCP process, the frozen three-tool surface, a disposable pending/approval/recall lifecycle, sustained local load, local process shutdown, checked-in generic and Cursor configurations, and the Hermes package configuration path. The JSON evidence contains the repository SHA, UTC timestamp, runtime details, scenario results, and a SHA-256 digest. The Markdown artifact is the written fail-closed go/no-go decision and gate checklist.

Local approval uses the isolated test authority only. It is not a public MCP tool and is not hosted evidence. On non-Linux systems, Hermes native install and rollback remain an explicit external gate.

## MCP URL versus Agent Memory URL

These URLs serve different protocols and are not interchangeable:

- `LUCY_MCP_HTTP_URL` is the operator-supplied hosted **Streamable HTTP MCP endpoint** used by a Claude-compatible remote MCP client. The repository does not invent a default for it.
- `LUCY_MEMORY_BASE_URL` is the **Agent Memory HTTP v1 API base URL** used internally by the Lucy MCP process after a client connects.

The checked-in Generic MCP and Cursor templates launch the local stdio process, so they configure `LUCY_MEMORY_BASE_URL`. Hosted HTTP conformance requires the separately deployed `LUCY_MCP_HTTP_URL` plus hosted evidence.

## Real chat comparison inputs

The runner accepts independently collected before/during chat JSON:

```sh
node scripts/private-beta-certify.mjs \
  --before-chat evidence/chat-before.json \
  --during-chat evidence/chat-during.json \
  --external evidence/hosted-gates.json
```

The runner hashes and records those inputs. It does not invent an SLO or turn local/mock measurements into hosted proof. `external.chat_comparison` must explicitly identify `evidence_mode: "hosted"` and `passed: true` for the gate to pass.
When both inputs contain numeric `p95_ms` and `error_rate` fields, the evidence also records the observed during-minus-before deltas without assigning a pass threshold.

## Known local-only evidence

These commits may be cited as local proof, but they do not satisfy hosted gates:

- LUC-1073 OAuth resource server: `bf9fdecb8b6854909e5023e06d5c1f8f1baeaec4` (focused OAuth tests 6/6; `check:full` 284 total, 204 passed, 80 platform-skipped, 0 failed)
- LUC-1075 MCP protection controls: `1866b565f5d7920103f709aa3707e93be44ca7a2` (MCP tests 47/47; types, `check:full`, validation, hashes, secrets, audit, and package dry-run passed)
- LUC-1077 adversarial harness: `7acfb7274154a012337a197585e86db08cd60f19` (`test:adversarial` 11/11; `check:full` 289 total, 209 passed, 80 skipped, 0 failed)
- LUC-1074 MCP exchange half: `7537184e701ba39c606b988c05a3406387aacd68`, bearer-free correction `a1fa9534f92bf7e5fc94eed29e9611561f612cfa` (trusted context is limited to `subject`, `workspaceId`, and `scopes`; mocked HTTP recall/propose and fail-closed exchange validation)
- LUC-1076 operability controls: `b64873f343ded5e7cdf4d5e2218d5a57b270e762` (local telemetry, kill-switch, rollback, and alarm/drill controls)

The LUC-1077 fixtures require no change for the bearer-free LUC-1074 contract: identity remains derived at the validated grant boundary and the no-passthrough assertions remain aligned. This is compatibility evidence, not hosted proof.

LUC-1073 source proof does not satisfy hosted OAuth certification. The selected provider configuration, deployed PRODUCT exchange, and staging execution evidence remain required.

LUC-1075 source proof does not satisfy hosted protection certification. The Vercel Firewall rule, PRODUCT shared-authority integration, deployed two-instance evidence, and operator-configured ceilings remain required.

Earlier ECS artifacts and source baselines are legacy evidence only. LUC-1078 selects the separate `lucy-memory-mcp` Vercel project in `iad1`; no ECS artifact is deployment evidence for this release.

## Fail-closed go/no-go

The generated decision is `NO-GO` unless every gate below is backed by external evidence:

- LUC-1073 OAuth resource-server validation
- LUC-1074 scoped credential exchange
- LUC-1075 distributed rate limits/shared protection
- LUC-1076 hosted observability, kill switch, healthy-chat proof, and rollback
- LUC-1077 adversarial isolation suite
- LUC-905 proposal-contract resolution
- staging adapter and HTTPS endpoint
- live Vercel project settings, deployment identity, redacted logs, and Instant Rollback evidence
- OAuth resource server, audience, and client credentials
- product-side service-authenticated credential mint/exchange integration
- two authorized disposable workspaces
- hosted revocation/TTL and limit/billing behavior
- sampled hosted log access and an explicit auto-memory policy
- verified `iad1` region, Fluid compute, 2 GB memory, 60-second duration, and public hostname
- real deployed connector, service, and harness commit SHAs
- Claude-compatible hosted HTTP MCP conformance
- real before/during chat comparison at beta load
- supported Linux Hermes install and rollback
- confirmed support capacity and named owners

The external JSON is evidence input, not a self-attestation shortcut. Review its referenced artifacts before changing a gate to `passed`.
