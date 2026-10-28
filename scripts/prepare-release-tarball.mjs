import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(`Release tarball failed: ${message}`);
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    fail(`${label} must be valid JSON`);
  }
}

export function validatePackResult(result, expected) {
  if (!Array.isArray(result) || result.length !== 1) fail('npm pack must produce exactly one artifact');
  const artifact = result[0];
  if (artifact?.name !== expected.name || artifact?.version !== expected.version) {
    fail('packed name and version must match package.json');
  }
  if (
    typeof artifact.filename !== 'string' ||
    basename(artifact.filename) !== artifact.filename ||
    !/^[A-Za-z0-9._-]+\.tgz$/.test(artifact.filename)
  ) {
    fail('npm pack returned an unsafe filename');
  }
  return artifact.filename;
}

function assertInside(root, path) {
  const rootPrefix = `${realpathSync(root)}${sep}`;
  if (!realpathSync(path).startsWith(rootPrefix)) fail('tarball escaped the repository');
}

export function prepareReleaseTarball({ root = process.cwd(), env = process.env } = {}) {
  const packageJson = parseJson(readFileSync(resolve(root, 'package.json'), 'utf8'), 'package.json');
  const packed = parseJson(execFileSync('npm', ['pack', '--ignore-scripts', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit']
  }), 'npm pack output');
  const filename = validatePackResult(packed, packageJson);
  const tarballPath = resolve(root, filename);
  assertInside(root, tarballPath);
  if (!lstatSync(tarballPath).isFile()) fail('tarball must be a regular file');

  const bytes = readFileSync(tarballPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fixture = mkdtempSync(resolve(tmpdir(), 'lucy-release-'));
  try {
    writeFileSync(resolve(fixture, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
    execFileSync('npm', [
      'install',
      '--ignore-scripts',
      '--prefer-offline',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarballPath
    ], { cwd: fixture, stdio: 'inherit' });

    const installedRoot = resolve(fixture, 'node_modules', ...packageJson.name.split('/'));
    const installedPackage = parseJson(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'), 'installed package.json');
    if (installedPackage.name !== packageJson.name || installedPackage.version !== packageJson.version) {
      fail('installed tarball identity does not match package.json');
    }
    if (!lstatSync(resolve(installedRoot, 'src', 'mcp', 'bin.mjs')).isFile()) {
      fail('installed tarball is missing the MCP executable');
    }
    execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const m = await import(${JSON.stringify(pathToFileURL(resolve(installedRoot, 'src', 'client', 'index.mjs')).href)}); if (typeof m.AgentMemoryClient !== 'function') process.exit(1);`
    ], { cwd: fixture, stdio: 'inherit' });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `tarball=${filename}\nsha256=${sha256}\n`, { encoding: 'utf8' });
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `Published artifact candidate: \`${filename}\`  \nSHA-256: \`${sha256}\`\n`, { encoding: 'utf8' });
  }
  process.stdout.write(`release-tarball PASS ${filename} sha256=${sha256}\n`);
  return { filename, sha256 };
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    prepareReleaseTarball({ root: resolve(dirname(fileURLToPath(import.meta.url)), '..') });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release tarball failed'}\n`);
    process.exitCode = 1;
  }
}
