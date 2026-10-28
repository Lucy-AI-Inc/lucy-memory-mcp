import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`Release gate failed: ${message}`);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

function validateLicense(license, root) {
  if (typeof license !== 'string' || license.trim() === '' || license === 'UNLICENSED') {
    fail('package.json must declare the approved public license');
  }

  const prefix = 'SEE LICENSE IN ';
  if (!license.startsWith(prefix)) return;

  const licenseReference = license.slice(prefix.length);
  const licensePath = resolve(root, licenseReference);
  const relativePath = relative(resolve(root), licensePath);
  if (
    licenseReference === '' ||
    isAbsolute(licenseReference) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    !existsSync(licensePath) ||
    !lstatSync(licensePath).isFile()
  ) {
    fail('package.json license file must be a regular file inside the repository');
  }
}

export function validateReleaseMetadata({ packageJson, lockfile, tag, root = process.cwd() }) {
  if (packageJson.private !== false) {
    fail('package.json must explicitly set private to false before public publishing');
  }
  if (packageJson.name !== '@trylucy/agent-memory') {
    fail('package name must remain @trylucy/agent-memory');
  }
  if (typeof packageJson.version !== 'string' || !SEMVER.test(packageJson.version)) {
    fail('package version must be valid SemVer');
  }
  validateLicense(packageJson.license, root);

  const expectedTag = `v${packageJson.version}`;
  if (tag !== expectedTag) fail(`tag must be exactly ${expectedTag}`);

  const lockedRoot = lockfile?.packages?.[''];
  if (lockedRoot?.name !== packageJson.name || lockedRoot?.version !== packageJson.version) {
    fail('package-lock.json root name and version must match package.json');
  }
}

export function validateNpmVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) fail('npm version could not be parsed');
  const [, majorText, minorText, patchText] = match;
  const [major, minor, patch] = [majorText, minorText, patchText].map(Number);
  if (major < 11 || (major === 11 && (minor < 5 || (minor === 5 && patch < 1)))) {
    fail('npm 11.5.1 or newer is required for trusted publishing');
  }
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}

export function verifyReleaseEnvironment({ root = process.cwd(), env = process.env } = {}) {
  if (env.GITHUB_REF_TYPE !== 'tag') fail('workflow must run from a tag ref');
  const tag = env.GITHUB_REF_NAME;
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag)) {
    fail('release tag has an invalid format');
  }
  if (typeof env.GITHUB_SHA !== 'string' || !SHA.test(env.GITHUB_SHA)) {
    fail('GITHUB_SHA must be a full lowercase commit digest');
  }

  const packageJson = readJson(resolve(root, 'package.json'), 'package.json');
  const lockfile = readJson(resolve(root, 'package-lock.json'), 'package-lock.json');
  validateReleaseMetadata({ packageJson, lockfile, tag, root });

  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const taggedCommit = git(root, ['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  if (head !== env.GITHUB_SHA || taggedCommit !== env.GITHUB_SHA) {
    fail('checked-out commit, tag target, and GITHUB_SHA must be identical');
  }
  try {
    git(root, ['merge-base', '--is-ancestor', env.GITHUB_SHA, 'origin/main']);
  } catch {
    fail('release commit must be reachable from origin/main');
  }
  if (git(root, ['status', '--porcelain=v1']) !== '') fail('release checkout must be clean');

  const npmVersion = execFileSync('npm', ['--version'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
  validateNpmVersion(npmVersion);
  return { name: packageJson.name, version: packageJson.version, tag, commit: env.GITHUB_SHA };
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyReleaseEnvironment({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
    process.stdout.write(`release-gate PASS ${result.name}@${result.version} ${result.commit}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release gate failed'}\n`);
    process.exitCode = 1;
  }
}
