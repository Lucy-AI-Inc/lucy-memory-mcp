import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/Lucy-AI-Inc/lucy-memory-mcp.git';
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let sourceRoot;

/** A committed source fixture: tracked bytes come from HEAD; dependencies are copied locally. */
export function cleanHermesSource() {
  if (sourceRoot) return join(sourceRoot, 'src/mcp/bin.mjs');
  sourceRoot = mkdtempSync(join(tmpdir(), 'lucy-hermes-clean-source-'));
  execFileSync('sh', ['-c', 'git archive HEAD | tar -x -C "$1"', 'sh', sourceRoot], { cwd: root });
  cpSync(join(root, 'node_modules'), join(sourceRoot, 'node_modules'), { recursive: true });
  execFileSync('git', ['init'], { cwd: sourceRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: sourceRoot });
  execFileSync('git', ['config', 'user.name', 'Hermes fixture'], { cwd: sourceRoot });
  execFileSync('git', ['add', '-A'], { cwd: sourceRoot });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: sourceRoot, stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', REPOSITORY], { cwd: sourceRoot });
  process.once('exit', () => rmSync(sourceRoot, { recursive: true, force: true }));
  return join(sourceRoot, 'src/mcp/bin.mjs');
}

export function cleanHermesSourceGitSha() {
  cleanHermesSource();
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
}
