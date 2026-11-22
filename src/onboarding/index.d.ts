export interface CopilotRepositorySkillInstallResult {
  path: string;
  changed: boolean;
}

/** Canonical Lucy memory-first skill text packaged with this module. */
export function usageSkillText(): string;

/** Concise model-visible cue derived from the canonical skill frontmatter. */
export function usageSkillCue(): string;

/** Install exact canonical skill bytes into a caller-provided Copilot repository. */
export function installCopilotRepositorySkill(repositoryRoot: string): Readonly<CopilotRepositorySkillInstallResult>;
