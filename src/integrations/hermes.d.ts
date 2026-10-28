export interface HermesLucyArtifactOptions {
  sourcePath: string;
  nodePath: string;
  /** Optional explicit absolute npm-cli.js selected for the offline lockfile build. */
  npmPath?: string;
  version: string;
  /** Externally obtained full Git commit ID that this local checkout must equal. */
  expectedSourceGitSha: string;
  compatibility?: { hermes?: string };
  /** Required alongside compatibility.hermes whenever a matching private artifact cache is reused. */
  trustedHermesVersion?: string;
}

/** Node runtime compatibility verified while the artifact was built. */
export interface HermesLucyArtifactNodeCompatibility {
  required_range: string;
  verified_version: string;
}

/** Optional Hermes host compatibility verified while the artifact was built. */
export interface HermesLucyArtifactHermesCompatibility {
  required_range: string;
  verified_host_version: string;
}

/** Compatibility data emitted in the build manifest and artifact receipt. */
export interface HermesLucyArtifactCompatibility {
  node: HermesLucyArtifactNodeCompatibility;
  hermes?: HermesLucyArtifactHermesCompatibility;
}

/** Dependency bytes provenance emitted in the build manifest and artifact receipt. */
export interface HermesLucyArtifactDependencyProvenance {
  type: 'npm_ci_offline_lockfile';
  lockfile: 'package-lock.json';
  lockfile_sha256: string;
  closure_digest: string;
  npm_cli_version: string;
}

export interface HermesLucyArtifactReceipt {
  format: 2;
  version: string;
  path: string;
  entrypoint: string;
  node_path: string;
  artifact_digest: string;
  source_git_sha: string;
  package_name: string;
  package_version: string;
  source_repository: string;
  source_git_closure_digest: string;
  dependency_provenance: HermesLucyArtifactDependencyProvenance;
  compatibility: HermesLucyArtifactCompatibility;
  created_at: string;
  /** Absolute, isolated-profile path of the private receipt file. */
  receiptPath: string;
}

export interface HermesLucyInstallOptions {
  profilePath: string;
  artifact: HermesLucyArtifactOptions;
  baseUrl: string;
  tokenEnv: string;
  /** Raw tokens are deliberately rejected; use tokenEnv. */
  token?: never;
  /** Exactly memory:read and memory:propose, in that order. */
  permissions?: ['memory:read', 'memory:propose'];
  allowInsecureLoopback?: boolean;
}

export interface HermesLucyMcpConfig {
  command: string;
  args: [string];
  env: Record<string, string>;
  x_lucy_memory_artifact: {
    version: string;
    artifact_digest: string;
    source_git_sha: string;
    package_name: string;
    package_version: string;
    source_repository: string;
    compatibility: HermesLucyArtifactCompatibility;
    receipt_path: string;
  };
}

export type HermesLucyMcpConfigOptions = Omit<HermesLucyInstallOptions, 'artifact'> & { artifact: HermesLucyArtifactReceipt };

export function installHermesLucyArtifact(profilePath: string, options: HermesLucyArtifactOptions): HermesLucyArtifactReceipt;
export function lucyMcpConfig(options: HermesLucyMcpConfigOptions): HermesLucyMcpConfig;
export function installHermesLucyConfig(configPath: string, options: HermesLucyInstallOptions): { path: string; backup: string | null; artifact: HermesLucyArtifactReceipt };
export function updateHermesLucyConfig(configPath: string, options: HermesLucyInstallOptions): { path: string; backup: string | null; artifact: HermesLucyArtifactReceipt };
export function rollbackHermesLucyConfig(configPath: string, options: { profilePath: string; receiptPath: string; /** Trusted source file under the Git checkout used to bind rollback bytes. */ sourcePath: string; /** Full externally pinned Git SHA for sourcePath. */ expectedSourceGitSha: string; /** Explicit absolute Node executable selected from the independently trusted runtime distribution used for the rollback rebuild. */ trustedNodePath: string; /** Required when the receipt declares compatibility.hermes. */ trustedHermesVersion?: string }): { path: string; artifact: HermesLucyArtifactReceipt };
export function uninstallHermesLucyConfig(configPath: string, options: { profilePath: string }): { restored: false; removed?: boolean };
/** Removes only the private pre-install YAML backup; versioned artifact and receipt caches are retained. */
export function resetHermesLucyBackup(configPath: string, options: { profilePath: string }): void;
/** @deprecated Use resetHermesLucyBackup. This legacy alias removes only the private YAML backup; artifact and receipt caches are retained. */
export function resetHermesLucyArtifacts(configPath: string, options: { profilePath: string }): void;
export function hermesLucyStatus(configPath: string): {
  installed: boolean;
  hasToken?: boolean;
  baseUrl?: string | null;
  permissions?: string | null;
  artifact?: string | null;
};
