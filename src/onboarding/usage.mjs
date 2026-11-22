import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'contracts/agent-manifest.json'), 'utf8'));
let usageSkill = '';
try {
  usageSkill = readFileSync(join(root, '.github/skills/lucy-memory-first/SKILL.md'), 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
export const LUCY_USAGE_SKILL = usageSkill;

export function usageSkillText() {
  return LUCY_USAGE_SKILL;
}

export function usageSkillCue() {
  const frontmatter = LUCY_USAGE_SKILL.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const description = frontmatter?.[1].match(/^description:\s*>-\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))+)/m);
  if (!description) return '';
  const text = description[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  return text ? `Memory-first guidance: ${text}` : '';
}

export function installCopilotRepositorySkill(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || repositoryRoot.trim() === '') {
    throw new TypeError('repositoryRoot must be a non-empty path.');
  }
  if (!LUCY_USAGE_SKILL) throw new Error('The packaged Lucy memory-first skill is unavailable.');
  const target = join(repositoryRoot, '.github', 'skills', 'lucy-memory-first', 'SKILL.md');
  mkdirSync(dirname(target), { recursive: true });
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const changed = current !== LUCY_USAGE_SKILL;
  if (changed) writeFileSync(target, LUCY_USAGE_SKILL, 'utf8');
  return Object.freeze({ path: target, changed });
}

export function publicManifest() {
  return manifest;
}
