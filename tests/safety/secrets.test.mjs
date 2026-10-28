import assert from 'node:assert/strict';
import test from 'node:test';
import { detectSecret } from '../../src/safety/secrets.mjs';
import {
  sampleAnthropicKey,
  sampleAwsKey,
  sampleGithubFineGrainedToken,
  sampleGithubToken,
  sampleGoogleApiKey,
  sampleJwt,
  sampleNpmToken,
  sampleOpenaiKey,
  sampleOpenRouterKey,
  sampleOpenaiProjectKey,
  samplePasswordAssignment,
  samplePem,
  sampleSlackToken,
  sampleSlackAppToken,
} from './secret-samples.mjs';

test('secret detector catches constructed credentials and ignores ordinary text', () => {
  assert.equal(detectSecret(samplePasswordAssignment()), true);
  assert.equal(detectSecret('api_key: abcdefghijklmnop'), true);
  assert.equal(detectSecret('Bearer abcdefghijklmnopqr'), true);
  assert.equal(detectSecret(sampleOpenaiKey()), true);
  assert.equal(detectSecret(sampleOpenaiProjectKey()), true);
  assert.equal(detectSecret(sampleAnthropicKey()), true);
  assert.equal(detectSecret(sampleOpenRouterKey()), true);
  assert.equal(detectSecret(sampleGithubToken()), true);
  assert.equal(detectSecret(sampleGithubFineGrainedToken()), true);
  assert.equal(detectSecret(sampleJwt()), true);
  assert.equal(detectSecret(sampleSlackToken()), true);
  assert.equal(detectSecret(sampleSlackAppToken()), true);
  assert.equal(detectSecret(sampleNpmToken()), true);
  assert.equal(detectSecret(sampleGoogleApiKey()), true);
  assert.equal(detectSecret(sampleAwsKey()), true);
  assert.equal(detectSecret(samplePem()), true);
  assert.equal(detectSecret('Always cite Lucy IDs'), false);
  assert.equal(detectSecret('what is 2+2'), false);
  assert.equal(detectSecret('Prefer gold accents'), false);
});
