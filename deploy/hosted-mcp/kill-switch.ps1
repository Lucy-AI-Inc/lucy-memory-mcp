param(
  [Parameter(Mandatory)][ValidatePattern('^lucy-memory-mcp(?:-[a-z0-9-]+)?$')][string]$Service,
  [string]$Cluster,
  [string]$RuleArn,
  [ValidateSet('Plan', 'EcsScaleDown', 'AlbFixedResponse')][string]$Mode = 'Plan'
)
$ErrorActionPreference = 'Stop'
if ($Service -match 'chat') { throw 'Chat targets are forbidden.' }
if ($Mode -eq 'Plan') {
  [pscustomobject]@{ service = $Service; action = 'none'; apply = $false; chat_affected = $false } | ConvertTo-Json -Compress
  exit
}
if ($Mode -eq 'EcsScaleDown') {
  if (-not $Cluster) { throw 'Cluster is required.' }
  aws ecs update-service --cluster $Cluster --service $Service --desired-count 0 --no-cli-pager
  exit
}
if (-not $RuleArn) { throw 'RuleArn is required.' }
$Action = '[{"Type":"fixed-response","FixedResponseConfig":{"MessageBody":"{\"error\":{\"code\":\"hosted_mcp_disabled\",\"message\":\"Hosted Lucy Memory MCP is disabled.\"}}","StatusCode":"503","ContentType":"application/json"}}]'
aws elbv2 modify-rule --rule-arn $RuleArn --actions $Action --no-cli-pager
