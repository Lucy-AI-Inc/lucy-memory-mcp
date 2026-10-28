import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findSecretHits, scanBuffer, scanTree } from '../../scripts/scan-secrets.mjs';
import { gzipSync } from 'node:zlib';
import {
  sampleAnthropicKey,
  sampleAwsKey,
  sampleGithubToken,
  sampleJwt,
  sampleOpenRouterKey,
  samplePem,
  sampleSlackAppToken,
  sampleStripeLive,
  sampleSupabaseRole,
} from '../safety/secret-samples.mjs';

test('repository scanner fails on real-looking secrets even under tests/ and fixtures/', () => {
  const root = mkdtempSync(join(tmpdir(), 'lucy-scan-root-'));
  try {
    const testsDir = join(root, 'tests', 'nested');
    const fixturesDir = join(root, 'fixtures');
    mkdirSync(testsDir, { recursive: true });
    mkdirSync(fixturesDir, { recursive: true });
    writeFileSync(join(testsDir, 'aws.txt'), sampleAwsKey());
    writeFileSync(join(testsDir, 'github.txt'), sampleGithubToken());
    writeFileSync(join(fixturesDir, 'jwt.txt'), sampleJwt());
    writeFileSync(join(fixturesDir, 'pem.txt'), samplePem());
    writeFileSync(join(testsDir, 'stripe.txt'), sampleStripeLive());
    writeFileSync(join(fixturesDir, 'supabase.txt'), sampleSupabaseRole());
    const hits = scanTree(root);
    assert.ok(hits.some((hit) => hit.includes('tests/nested/aws.txt')));
    assert.ok(hits.some((hit) => hit.includes('tests/nested/github.txt')));
    assert.ok(hits.some((hit) => hit.includes('fixtures/jwt.txt')));
    assert.ok(hits.some((hit) => hit.includes('fixtures/pem.txt')));
    assert.ok(hits.some((hit) => hit.includes('tests/nested/stripe.txt')));
    assert.ok(hits.some((hit) => hit.includes('fixtures/supabase.txt')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('repository scanner covers every tracked-style file extension and large files', () => {
  const root = mkdtempSync(join(tmpdir(), 'lucy-scan-all-files-'));
  try {
    const githubFineGrained = `github_${'pat_'}${'A'.repeat(30)}`;
    const slack = `xox${'b-'}${'A'.repeat(24)}`;
    mkdirSync(join(root, 'evidence'), { recursive: true });
    writeFileSync(join(root, 'evidence', 'runtime.log'), githubFineGrained);
    writeFileSync(join(root, 'script.py'), slack);
    writeFileSync(join(root, 'config.toml'), `${'x'.repeat(2_100_000)}\n${sampleAwsKey()}`);
    const hits = scanTree(root);
    assert.ok(hits.some((hit) => hit.includes('evidence/runtime.log')));
    assert.ok(hits.some((hit) => hit.includes('script.py')));
    assert.ok(hits.some((hit) => hit.includes('config.toml')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('constructed samples match scanner signatures while ordinary text does not', () => {
  assert.ok(findSecretHits(sampleAwsKey()).length > 0);
  assert.ok(findSecretHits(sampleGithubToken()).length > 0);
  assert.ok(findSecretHits(sampleJwt()).length > 0);
  assert.ok(findSecretHits(samplePem()).length > 0);
  assert.ok(findSecretHits(sampleStripeLive()).length > 0);
  assert.ok(findSecretHits(sampleSupabaseRole()).length > 0);
  assert.ok(findSecretHits(`sk-${'proj-'}${'A'.repeat(24)}`).length > 0);
  assert.ok(findSecretHits(`github_${'pat_'}${'A'.repeat(30)}`).length > 0);
  assert.ok(findSecretHits(`xox${'b-'}${'A'.repeat(24)}`).length > 0);
  assert.ok(findSecretHits(`npm_${'A'.repeat(24)}`).length > 0);
  assert.ok(findSecretHits(sampleAnthropicKey()).length > 0);
  assert.ok(findSecretHits(sampleOpenRouterKey()).length > 0);
  assert.ok(findSecretHits(sampleSlackAppToken()).length > 0);
  assert.equal(findSecretHits('Always cite Lucy IDs').length, 0);
  assert.equal(findSecretHits('test-token').length, 0);
});

test('gzipped archive scan decompresses and detects planted credentials', () => {
  const raw = Buffer.from(`note\n${sampleAwsKey()}\n`, 'utf8');
  assert.ok(scanBuffer('raw', raw).length > 0);
  const gzipped = gzipSync(raw);
  assert.equal(findSecretHits(gzipped.toString('latin1')).length, 0);
  const hits = scanBuffer('planted.tgz', gzipped);
  assert.ok(hits.some((hit) => hit.includes('planted.tgz')));
});
