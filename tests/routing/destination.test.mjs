import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyOutbound, classifyPrompt } from '../../src/routing/destination.mjs';
import { detectSecret } from '../../src/safety/secrets.mjs';
import { sampleGithubToken, sampleOpenaiKey } from '../safety/secret-samples.mjs';

test('recall routing: durable yes, arithmetic/weather no', () => {
  assert.equal(classifyPrompt('remember my preferred name').shouldRecall, true);
  assert.equal(classifyPrompt('what did we decide for the project rule').destination, 'lucy');
  assert.equal(classifyPrompt('what is 2+2').shouldRecall, false);
  assert.equal(classifyPrompt('weather in denver').reason, 'current_events');
  assert.equal(classifyPrompt('draft this email').shouldRecall, false);
});

test('outbound routing rejects secrets and temporary facts', () => {
  assert.equal(classifyOutbound({ content: `api_key=${sampleOpenaiKey()}`, durable: true }).destination, 'reject');
  assert.equal(classifyOutbound({ content: 'temp', temporary: true }).destination, 'session');
  assert.equal(classifyOutbound({ content: 'Ada', durable: true }).shouldPropose, true);
  assert.equal(detectSecret(`Bearer ${sampleGithubToken()}`), true);
});
