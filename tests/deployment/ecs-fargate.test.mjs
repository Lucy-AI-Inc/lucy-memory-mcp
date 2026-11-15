import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("container is immutable, non-root, and starts the hosted transport", async () => {
  const dockerfile = await read("Dockerfile");
  assert.match(dockerfile, /^FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /RUN test -f src\/mcp\/http\.mjs/);
  assert.match(dockerfile, /CMD \["node", "src\/mcp\/http\.mjs"\]/);
  assert.match(dockerfile, /\/healthz/);
});

test("stack isolates service, secrets, ingress, and egress", async () => {
  const source = await read("infra/ecs-fargate.yml");
  assert.match(source, /Type: AWS::ECS::Service/);
  assert.match(source, /Type: AWS::ECS::TaskDefinition/);
  assert.match(source, /Type: AWS::WAFv2::WebACLAssociation/);
  assert.match(source, /HealthCheckPath: \/healthz/);
  assert.match(source, /ReadonlyRootFilesystem: true/);
  assert.match(source, /AssignPublicIp: DISABLED/);
  assert.match(source, /Rollback: true/);
  assert.equal((source.match(/ToPort: 443/g) ?? []).length, 3);
  assert.doesNotMatch(source, /0\.0\.0\.0\/0|::\/0|supabase|postgres|chat.worker/i);
  assert.match(source, /secret:lucy\/mcp\//);
  assert.match(source, /LUCY_MCP_HTTP_STATIC_BEARER_TOKEN/);
  assert.match(source, /ProductionHasNoStaticBearer/);
  assert.match(source, /Type: AWS::WAFv2::WebACL/);
  assert.match(source, /RejectOversizedRequestBodies/);
  assert.match(source, /RateLimitBySourceIp/);
  assert.match(source, /LUCY_MEMORY_MAX_BODY_BYTES/);
  assert.match(source, /LUCY_MEMORY_MAX_CONCURRENT_PER_TASK/);
  assert.match(source, /LUCY_MEMORY_ADMISSION_MODULE/);
  assert.match(source, /MaxValue: 8192/);
  assert.match(source, /WebAclArn:\s*\n\s+Value: !GetAtt WebAcl\.Arn/);
  assert.match(source, /ServiceName:\s+!Sub lucy-memory-mcp-\$\{EnvironmentName\}/);
  assert.match(source, /HttpsForwardRuleArn:\s*\n\s+Value: !Ref HttpsForwardRule/);
  assert.match(source, /TargetGroupArn:\s*\n\s+Value: !Ref TargetGroup/);
});

test("workflow deploys and verifies an exact source-SHA image", async () => {
  const workflow = await read(".github/workflows/deploy-mcp.yml");
  assert.match(workflow, /:\$\{GITHUB_SHA\}/);
  assert.match(workflow, /\^sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(workflow, /@\$\{digest\}/);
  assert.match(workflow, /aws ecs wait services-stable/);
  assert.match(workflow, /test "\$deployed_image" = "\$EXPECTED_IMAGE"/);
  assert.match(workflow, /Capture rollback revision/);
  assert.match(workflow, /desired_count/);
  assert.match(workflow, /EGRESS_FIREWALL_ENDPOINT_IDS/);
  assert.match(workflow, /FirewallStatus\.Status/);
  assert.match(workflow, /MCP_MAX_REQUEST_BODY_BYTES/);
  assert.match(workflow, /MCP_WAF_REQUESTS_PER_FIVE_MINUTES/);
  assert.match(workflow, /APPROVED_EGRESS_PREFIX_LIST_ID/);
  assert.doesNotMatch(workflow, /AWS_REGION:\s+(us-|eu-|ap-|sa-|ca-|me-|af-)/);
});
