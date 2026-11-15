# Isolated ECS Fargate operations

This repository defines a dedicated `lucy-memory-mcp-<environment>` ECS service in
[`infra/ecs-fargate.yml`](../../infra/ecs-fargate.yml). It does not create DNS,
routes, a firewall, secrets, an ECS cluster, or an ECR repository. Those are
environment authority decisions, not safe workflow defaults.

## Required protected-environment configuration

Configure the selected GitHub environment with:

- `AWS_ACCOUNT_ID`, `AWS_REGION`, `AWS_ROLE_ARN`, and `ECR_REPOSITORY`
- `ECS_CLUSTER_ARN`, `VPC_ID`, `PUBLIC_SUBNET_IDS`, and `PRIVATE_SUBNET_IDS`
- `CERTIFICATE_ARN` and `MCP_HOSTNAME`
- `ALB_INGRESS_PREFIX_LIST_ID` for approved staging clients
- `APPROVED_EGRESS_PREFIX_LIST_ID` for only the shared admission authority and
  approved Agent Memory/auth HTTPS destinations
- `AWS_ENDPOINT_SECURITY_GROUP_ID` for private ECR, Logs, and Secrets Manager endpoints
- `EGRESS_FIREWALL_ARN` for the firewall already routing the private subnets
- `EGRESS_FIREWALL_ENDPOINT_IDS`, a comma-separated allowlist of the firewall
  VPC endpoint IDs used as the private subnet default-route targets
- `UPSTREAM_TOKEN_SECRET_ARN` under `lucy/mcp/`
- `AGENT_MEMORY_BASE_URL` and `MCP_ALLOWED_ORIGINS`
- `MCP_NODE_ENV` and `MCP_HTTP_AUTH_MODE`
- `MCP_MAX_REQUEST_BODY_BYTES`, enforced by both WAF on raw requests and the runtime on canonical tool arguments
- `MCP_MAX_CONCURRENT_PER_TASK`
- `MCP_WAF_REQUESTS_PER_FIVE_MINUTES`
- `MCP_ADMISSION_MODULE`, the in-container shared-authority adapter path

Production requires `MCP_NODE_ENV=production`,
`MCP_HTTP_AUTH_MODE=none`, and an empty `INBOUND_BEARER_SECRET_ARN`. Staging
requires `MCP_NODE_ENV=staging`, `MCP_HTTP_AUTH_MODE=staging-static-bearer`,
and an `INBOUND_BEARER_SECRET_ARN` under `lucy/mcp/`.

Private subnet route tables must have no NAT or internet-gateway default path.
Their approved outbound route must traverse the named Network Firewall, whose
TLS SNI rules allow only the Agent Memory and authorization destinations.
The task security group independently limits outbound traffic to TCP 443
through a maintained prefix list containing only the shared admission
authority plus approved Agent Memory/auth destinations, and the private AWS
endpoint security group.
A prefix list alone is not hostname enforcement.

The stack-owned regional WAF rejects request bodies over the configured byte
ceiling with 413 and applies the configured five-minute per-source-IP ceiling
with 429. These required environment values remain operator policy; the
repository does not invent production payload, spend, or QPS ceilings.

`MCP_MAX_REQUEST_BODY_BYTES` cannot exceed 8192 because an ALB-associated WAF
can inspect only the first 8 KiB; larger requests fail closed.

The stack outputs `ClusterArn`, `ServiceName`, `ServiceArn`,
`TaskDefinitionArn`, `LoadBalancerArn`, `LoadBalancerDnsName`,
`HttpsListenerArn`, `HttpsForwardRuleArn`, `TargetGroupArn`, and `WebAclArn`. Use
`ServiceName` plus `ClusterArn` for the LUC-1076 ECS scale-down drill and
`HttpsForwardRuleArn` for its ALB fixed-response drill. These are deployment
outputs, not inferred region, DNS, or live-execution evidence.

## Deploy and verify

Run **Deploy isolated MCP service** and select the protected environment. The
workflow builds `${GITHUB_SHA}`, resolves its ECR digest, deploys the digest
URI, waits for ECS stability, verifies the running task definition image, and
checks `https://<MCP_HOSTNAME>/healthz`. The stack output provides the ALB DNS
name for the operator-managed DNS record; do not use it as evidence that DNS
was changed.

Capture authenticated staging evidence separately:

1. `GET /healthz` returns `200 {"status":"ok"}` without credentials.
2. An unauthenticated `POST /mcp` is rejected.
3. An authenticated session completes initialize, `tools/list`, sanitized
   recall, and session shutdown; only the three governed memory tools appear.
4. A request to a test destination absent from both the prefix list and
   firewall SNI allowlist fails, while the approved upstream succeeds.
5. ECS service events, target health, task definition ARN, and ECR digest match
   the workflow result.

Source tests validate the configuration shape but are not live AWS evidence.

## Roll back

Every workflow run records the previous task definition ARN in its summary.
Run the printed `aws ecs update-service` command, wait for service stability,
then repeat health and protocol evidence. CloudFormation deployment circuit
breaking also rolls back a failed service deployment automatically.

## Scale to zero

Dispatch the workflow with desired count `0`. This changes only the MCP
service. Confirm ECS reaches zero running tasks and the ALB returns `503`
because the target group has no healthy targets. Restore the prior desired
count and repeat the rollout checks.
