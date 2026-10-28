import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import YAML from 'yaml';
import { validatePackResult } from '../../scripts/prepare-release-tarball.mjs';
import { validateNpmVersion, validateReleaseMetadata } from '../../scripts/verify-release.mjs';

const workflowText = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const workflow = YAML.parse(workflowText);
const ciText = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

const publicPackage = {
  name: '@trylucy/agent-memory',
  version: '1.2.3',
  private: false,
  license: 'MIT'
};
const matchingLock = { packages: { '': { name: publicPackage.name, version: publicPackage.version } } };

test('release metadata gate requires a deliberate public package and exact version tag', () => {
  assert.doesNotThrow(() => validateReleaseMetadata({
    packageJson: publicPackage,
    lockfile: matchingLock,
    tag: 'v1.2.3'
  }));
  assert.throws(() => validateReleaseMetadata({
    packageJson: { ...publicPackage, private: true },
    lockfile: matchingLock,
    tag: 'v1.2.3'
  }), /explicitly set private to false/);
  assert.throws(() => validateReleaseMetadata({
    packageJson: { ...publicPackage, private: undefined },
    lockfile: matchingLock,
    tag: 'v1.2.3'
  }), /explicitly set private to false/);
  assert.throws(() => validateReleaseMetadata({
    packageJson: { ...publicPackage, license: undefined },
    lockfile: matchingLock,
    tag: 'v1.2.3'
  }), /approved public license/);
  assert.throws(() => validateReleaseMetadata({
    packageJson: { ...publicPackage, name: '@trylucy/other-package' },
    lockfile: matchingLock,
    tag: 'v1.2.3'
  }), /must remain @trylucy\/agent-memory/);
  assert.throws(() => validateReleaseMetadata({
    packageJson: publicPackage,
    lockfile: matchingLock,
    tag: 'v1.2.4'
  }), /tag must be exactly v1\.2\.3/);
  assert.throws(() => validateReleaseMetadata({
    packageJson: publicPackage,
    lockfile: { packages: { '': { name: publicPackage.name, version: '1.2.2' } } },
    tag: 'v1.2.3'
  }), /package-lock\.json/);
});

test('release gate enforces an npm version that supports trusted publishing', () => {
  assert.doesNotThrow(() => validateNpmVersion('11.5.1'));
  assert.doesNotThrow(() => validateNpmVersion('12.0.0'));
  assert.throws(() => validateNpmVersion('11.5.0'), /11\.5\.1 or newer/);
  assert.throws(() => validateNpmVersion('10.9.2'), /11\.5\.1 or newer/);
});

test('tarball identity and filename are bound to validated package metadata', () => {
  assert.equal(validatePackResult([{
    name: publicPackage.name,
    version: publicPackage.version,
    filename: 'trylucy-agent-memory-1.2.3.tgz'
  }], publicPackage), 'trylucy-agent-memory-1.2.3.tgz');
  assert.throws(() => validatePackResult([{
    name: publicPackage.name,
    version: '1.2.2',
    filename: 'trylucy-agent-memory-1.2.2.tgz'
  }], publicPackage), /name and version/);
  assert.throws(() => validatePackResult([{
    name: publicPackage.name,
    version: publicPackage.version,
    filename: '../agent-memory.tgz'
  }], publicPackage), /unsafe filename/);
});

test('release workflow uses a tag-only, gated, least-privilege trusted publish', () => {
  assert.deepEqual(workflow.on, { push: { tags: ['v*'] } });
  assert.deepEqual(workflow.permissions, {});

  const verify = workflow.jobs.verify;
  const publish = workflow.jobs.publish;
  assert.deepEqual(verify.permissions, { contents: 'read' });
  assert.equal(verify.permissions['id-token'], undefined);
  assert.equal(publish.environment.name, 'npm');
  assert.deepEqual(publish.permissions, { 'id-token': 'write' });
  assert.equal(publish.needs, 'verify');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);

  const immutableCheckout = verify.steps.find(({ name }) => name === 'Check out immutable release source');
  assert.equal(immutableCheckout.with.ref, '${{ github.sha }}');
  assert.equal(immutableCheckout.with.path, 'release-source');
  assert.equal(immutableCheckout.with['persist-credentials'], false);
  const pack = verify.steps.find(({ id }) => id === 'pack');
  assert.equal(pack['working-directory'], 'release-source');
  assert.ok(
    verify.steps.indexOf(immutableCheckout) > verify.steps.findIndex(({ name }) => name === 'Validate package consumers'),
    'the immutable checkout must be created only after repository code and tests finish',
  );
  assert.ok(
    verify.steps.indexOf(pack) > verify.steps.indexOf(immutableCheckout),
    'the release tarball must be packed from the immutable checkout',
  );
  const upload = verify.steps.find(({ uses }) => uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.path, 'release-source/${{ steps.pack.outputs.tarball }}');

  const actions = [...verify.steps, ...publish.steps].filter((step) => step.uses).map((step) => step.uses);
  assert.ok(actions.length >= 2);
  for (const action of actions) assert.match(action, /^[^@]+@[0-9a-f]{40}$/);

  const commands = [...verify.steps, ...publish.steps].filter((step) => step.run).map((step) => step.run).join('\n');
  assert.match(commands, /node scripts\/verify-release\.mjs/);
  assert.match(commands, /npm audit --audit-level=moderate/);
  assert.match(commands, /npm run test:package/);
  assert.match(commands, /node scripts\/prepare-release-tarball\.mjs/);
  assert.match(commands, /EXPECTED_SHA256/);
  assert.match(commands, /npm publish "\$RELEASE_TARBALL" --provenance --access public --ignore-scripts/);
  assert.doesNotMatch(workflowText, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./);
  assert.match(ciText, /npm audit --audit-level=moderate/);
});
