import assert from 'node:assert/strict';
import test from 'node:test';
import { loadHostedMcpConfig } from '../../src/mcp/hosted-config.mjs';

const oauth = {
  HOSTED_MCP_ENABLED: 'true',
  HOSTED_MCP_CANONICAL_URL: 'https://mcp.example.test/mcp',
  HOSTED_MCP_PRODUCT_BASE_URL: 'https://product.example.test',
  HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: 'service-credential-000000000000000000000000',
  HOSTED_MCP_LOG_HASH_KEY: 'log-hash-key-000000000000000000000000000',
  HOSTED_MCP_OAUTH_ISSUER: 'https://issuer.example.test/',
  HOSTED_MCP_OAUTH_JWKS_URL: 'https://issuer.example.test/jwks',
  HOSTED_MCP_OAUTH_INTROSPECTION_URL: 'https://issuer.example.test/introspect',
  HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION: 'Basic provider-value',
};

test('OAuth config has conservative defaults and exact origins', () => {
  const config = loadHostedMcpConfig({
    ...oauth,
    HOSTED_MCP_ALLOWED_ORIGINS: 'https://one.example,https://two.example:8443',
  });
  assert.equal(config.authMode, 'oauth');
  assert.equal(config.callTimeoutMs, 55_000);
  assert.deepEqual(config.allowedOrigins, ['https://one.example', 'https://two.example:8443']);
  assert.equal(config.allowInsecureLoopback, false);
});

test('OAuth config rejects cleartext, pathful PRODUCT origins, weak service/log keys, and bad deadlines', () => {
  const cases = [
    { HOSTED_MCP_CANONICAL_URL: 'http://mcp.example.test/mcp' },
    { HOSTED_MCP_CANONICAL_URL: 'https://mcp.example.test/not-mcp' },
    { HOSTED_MCP_PRODUCT_BASE_URL: 'https://product.example.test/path' },
    { HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: 'short' },
    { HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: 'service,credential,000000000000000000000000' },
    { HOSTED_MCP_LOG_HASH_KEY: oauth.HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL },
    {
      HOSTED_MCP_LOG_HASH_KEY: 'shared-provider-value-0000000000000000',
      HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION: 'shared-provider-value-0000000000000000',
    },
    { HOSTED_MCP_OAUTH_INTROSPECTION_AUTHORIZATION: oauth.HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL },
    { HOSTED_MCP_CALL_TIMEOUT_MS: '55001' },
    { HOSTED_MCP_ALLOWED_ORIGINS: 'https://one.example,https://one.example' },
  ];
  for (const change of cases) assert.throws(() => loadHostedMcpConfig({ ...oauth, ...change }));
});

test('loopback HTTP requires explicit non-production opt-in', () => {
  const local = {
    ...oauth,
    HOSTED_MCP_CANONICAL_URL: 'http://127.0.0.1:3191/mcp',
    HOSTED_MCP_PRODUCT_BASE_URL: 'http://127.0.0.1:3190',
    HOSTED_MCP_OAUTH_ISSUER: 'http://127.0.0.1:3192',
    HOSTED_MCP_OAUTH_JWKS_URL: 'http://127.0.0.1:3192/jwks',
    HOSTED_MCP_OAUTH_INTROSPECTION_URL: 'http://127.0.0.1:3192/introspect',
    HOSTED_MCP_ALLOW_INSECURE_LOOPBACK: 'true',
    VERCEL_ENV: 'development',
  };
  const config = loadHostedMcpConfig(local);
  assert.equal(config.allowInsecureLoopback, true);
  assert.equal(config.oauthIssuer, 'http://127.0.0.1:3192');
  assert.throws(() => loadHostedMcpConfig({ ...local, VERCEL_ENV: 'production' }));
  assert.throws(() => loadHostedMcpConfig({ ...local, VERCEL: '1' }));
  assert.throws(() => loadHostedMcpConfig({ ...local, HOSTED_MCP_PRODUCT_BASE_URL: 'http://192.0.2.1:3190' }));
});

test('static bearer is preview-only, noncanonical, and mutually exclusive with every OAuth variable', () => {
  const base = {
    HOSTED_MCP_ENABLED: 'true',
    HOSTED_MCP_AUTH_MODE: 'staging-static-bearer',
    HOSTED_MCP_CANONICAL_URL: 'https://preview-mcp.example.test/mcp',
    HOSTED_MCP_PRODUCT_BASE_URL: 'https://product.example.test',
    HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL: oauth.HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL,
    HOSTED_MCP_LOG_HASH_KEY: oauth.HOSTED_MCP_LOG_HASH_KEY,
    HOSTED_MCP_STAGING_STATIC_BEARER: 'preview-only',
    HOSTED_MCP_STAGING_STATIC_SUBJECT: '11111111-1111-1111-1111-111111111111',
    HOSTED_MCP_STAGING_STATIC_WORKSPACE_ID: '22222222-2222-2222-2222-222222222222',
    HOSTED_MCP_STAGING_STATIC_SCOPES: 'memory:read',
    VERCEL_ENV: 'preview',
  };
  assert.equal(loadHostedMcpConfig(base).authMode, 'staging-static-bearer');
  assert.throws(() => loadHostedMcpConfig({ ...base, VERCEL_ENV: 'production' }));
  assert.throws(() => loadHostedMcpConfig({ ...base, VERCEL_ENV: undefined }));
  assert.throws(() => loadHostedMcpConfig({ ...base, HOSTED_MCP_CANONICAL_URL: 'https://mcp.trylucy.ai/mcp' }));
  assert.throws(() => loadHostedMcpConfig({ ...base, HOSTED_MCP_OAUTH_ISSUER: 'https://issuer.example.test/' }));
  assert.throws(() => loadHostedMcpConfig({
    ...base,
    HOSTED_MCP_STAGING_STATIC_BEARER: base.HOSTED_MCP_PRODUCT_SERVICE_CREDENTIAL,
  }));
});
