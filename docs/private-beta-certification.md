# Private-beta certification

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
- LUC-1077 adversarial harness: `7acfb7274154a012337a197585e86db08cd60f19` (`test:adversarial` 11/11; `check:full` 289 total, 209 passed, 80 skipped, 0 failed)
- LUC-1074 MCP exchange half: `7537184e701ba39c606b988c05a3406387aacd68`, bearer-free correction `a1fa9534f92bf7e5fc94eed29e9611561f612cfa` (trusted context is limited to `subject`, `workspaceId`, and `scopes`; mocked HTTP recall/propose and fail-closed exchange validation)
- LUC-1076 operability controls: `b64873f343ded5e7cdf4d5e2218d5a57b270e762` (local telemetry, kill-switch, rollback, and alarm/drill controls)

The LUC-1077 fixtures require no change for the bearer-free LUC-1074 contract: identity remains derived at the validated grant boundary and the no-passthrough assertions remain aligned. This is compatibility evidence, not hosted proof.

LUC-1073 source proof does not satisfy hosted OAuth certification. Route wiring from LUC-1070, configured LUC-1072 values and membership resolver, the deployed exchange, and staging execution evidence remain required.

The LUC-1069 topology decision record pins source baselines only: public MCP `a84db7211b104a80311cc7a610cfc228764c8a75`, internal MCP `db81d27ce159cdeb322735eb6ccb02c0691a1f86`, and product `c475c42c7408aac4a25e47ef52269f2f9065cdb0`. Dedicated isolated ECS Fargate is the selected topology. These are not deployment evidence.

## Fail-closed go/no-go

The generated decision is `NO-GO` unless every gate below is backed by external evidence:

- LUC-1073 OAuth resource-server validation
- LUC-1074 scoped credential exchange
- LUC-1075 distributed rate limits/shared protection
- LUC-1076 hosted observability, kill switch, healthy-chat proof, and rollback
- LUC-1077 adversarial isolation suite
- LUC-905 proposal-contract resolution
- staging adapter and HTTPS endpoint
- live ECS, ALB, CloudWatch, and immutable rollback evidence using LUC-1071 deployment identifiers and environment access
- OAuth resource server, audience, and client credentials
- product-side service-authenticated credential mint/exchange integration
- two authorized disposable workspaces
- hosted revocation/TTL and limit/billing behavior
- sampled hosted log access and an explicit auto-memory policy
- selected deployment region, public hostname, and Auto Scaling configuration
- real deployed connector, service, and harness commit SHAs
- Claude-compatible hosted HTTP MCP conformance
- real before/during chat comparison at beta load
- supported Linux Hermes install and rollback
- confirmed support capacity and named owners

The external JSON is evidence input, not a self-attestation shortcut. Review its referenced artifacts before changing a gate to `passed`.
