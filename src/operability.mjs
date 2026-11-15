import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SAFE_EVENTS = new Set(['tool', 'upstream', 'kill_switch']);
const SAFE_OUTCOMES = new Set(['success', 'error', 'disabled']);
const SAFE_ERROR_CODES = /^[a-z][a-z0-9_]{0,63}$/;
const SAFE_OPERATIONS = /^(memory_(recall|propose|proposal_status)|(canonical-)?recall|propose|proposal-status)$/;

export function workspaceHash(workspaceId, salt) {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0
    || typeof salt !== 'string' || salt.length < 16) return undefined;
  return createHash('sha256').update(`${salt}\0${workspaceId}`).digest('hex');
}

export function versionEvidence(environment = process.env) {
  const imageDigest = environment.LUCY_MCP_IMAGE_DIGEST;
  const imageGitSha = environment.LUCY_MCP_IMAGE_GIT_SHA;
  return Object.freeze({
    package_version: PACKAGE_VERSION,
    ...(typeof imageDigest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(imageDigest) ? { image_digest: imageDigest } : {}),
    ...(typeof imageGitSha === 'string' && /^[a-f0-9]{40}$/i.test(imageGitSha) ? { image_git_sha: imageGitSha } : {}),
  });
}

export function hostedMcpDisabledResponse() {
  return Object.freeze({
    status: 503,
    headers: Object.freeze({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
    body: '{"error":{"code":"hosted_mcp_disabled","message":"Hosted Lucy Memory MCP is disabled."}}',
  });
}

export function createOperabilityEmitter({
  write = (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  service = 'lucy-memory-mcp',
  workspaceId,
  workspaceSalt,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof write !== 'function') throw new TypeError('write must be a function.');
  const hashedWorkspace = workspaceHash(workspaceId, workspaceSalt);
  const versions = versionEvidence();
  return (event) => {
    if (!event || !SAFE_EVENTS.has(event.event) || !SAFE_OUTCOMES.has(event.outcome)
      || !SAFE_OPERATIONS.test(event.operation)
      || !Number.isFinite(event.duration_ms) || event.duration_ms < 0
      || (event.error_code !== undefined && !SAFE_ERROR_CODES.test(event.error_code))) {
      throw new TypeError('Operability event contains a non-allowlisted field value.');
    }
    const record = Object.freeze({
      timestamp: now(),
      service,
      event: event.event,
      operation: event.operation,
      outcome: event.outcome,
      duration_ms: Math.round(event.duration_ms * 1000) / 1000,
      trace_id: typeof event.trace_id === 'string' && /^[a-f0-9-]{16,64}$/i.test(event.trace_id)
        ? event.trace_id
        : randomUUID(),
      ...versions,
      ...(hashedWorkspace ? { workspace_hash: hashedWorkspace } : {}),
      ...(event.error_code ? { error_code: event.error_code } : {}),
      ...(Number.isInteger(event.status) ? { status: event.status } : {}),
      ...(event.throttled === true ? { throttled: true } : {}),
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: 'Lucy/HostedMCP',
          Dimensions: [['service', 'event', 'operation', 'outcome']],
          Metrics: [
            { Name: 'DurationMs', Unit: 'Milliseconds' },
            { Name: 'Count', Unit: 'Count' },
            { Name: 'Throttled', Unit: 'Count' },
            { Name: 'AuthenticationFailure', Unit: 'Count' },
            { Name: 'UpstreamError', Unit: 'Count' },
          ],
        }],
      },
      DurationMs: event.duration_ms,
      Count: 1,
      Throttled: event.throttled === true ? 1 : 0,
      AuthenticationFailure: event.error_code === 'authentication_failure' ? 1 : 0,
      UpstreamError: event.event === 'upstream' && event.outcome === 'error' ? 1 : 0,
    });
    write(record);
    return record;
  };
}
