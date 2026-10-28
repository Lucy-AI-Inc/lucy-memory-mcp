# Hermes integration

The Hermes helper installs a Lucy MCP entry into an isolated YAML profile and launches a versioned local artifact with an explicitly selected Node runtime.

Installer mutation is supported on Linux with trusted system executables at
`/usr/bin/flock` and `/usr/bin/git`. The installer does not resolve these
security-sensitive tools through `PATH`. macOS and Windows package tests do
not establish installer support.

## Install

```ts
import { installHermesLucyConfig } from '@trylucy/agent-memory/hermes';

const installed = installHermesLucyConfig('/absolute/profile/config.yaml', {
  profilePath: '/absolute/profile',
  artifact: {
    sourcePath: '/absolute/lucy-memory-mcp/src/mcp/bin.mjs',
    nodePath: process.execPath,
    version: '0.1.0',
    expectedSourceGitSha: '0123456789abcdef0123456789abcdef01234567',
    compatibility: { hermes: '>=0.30.0' },
    trustedHermesVersion: '0.30.0',
  },
  baseUrl: 'https://www.trylucy.ai',
  tokenEnv: 'LUCY_MEMORY_TOKEN',
});

console.log(installed.artifact.artifact_digest);
console.log(installed.artifact.receiptPath);
```

Use absolute paths. Obtain `expectedSourceGitSha` from a trusted release channel rather than from an untrusted checkout. The selected Node executable must satisfy the package's engine range.

The installer verifies tracked package bytes against the pinned Git commit, creates a private artifact closure, installs production dependencies offline with scripts disabled, and records a receipt and digest. The Hermes YAML stores an environment reference such as `${LUCY_MEMORY_TOKEN}` rather than the token value.

## Profile requirements

- Use a dedicated profile owned and writable only by the intended account.
- Keep the token in the Hermes service environment.
- Do not use a profile beneath a directory controlled by another user.
- Treat `nodePath` and an explicit `npmPath`, when supplied, as privileged installation inputs.
- Ensure every profile ancestor has a trusted owner and is not group- or world-writable. A system-owned sticky temporary directory is allowed.
- Keep the offline npm cache populated with the exact lockfile dependencies.

## Legacy configurations

Remove and rotate any raw Lucy token before running the installer against an
existing configuration. The installer rejects a literal
`mcp_servers.lucy.env.LUCY_MEMORY_TOKEN` before it creates installer state,
publishes an artifact, or writes a backup.

Migrate the credential to an uppercase environment variable, restrict the profile to the intended account, and then install the managed entry.

## Update and rollback

```ts
import {
  updateHermesLucyConfig,
  rollbackHermesLucyConfig,
} from '@trylucy/agent-memory/hermes';

updateHermesLucyConfig(configPath, nextOptions);

rollbackHermesLucyConfig(configPath, {
  profilePath,
  receiptPath,
  sourcePath: '/absolute/path/to/trusted/checkout/src/mcp/bin.mjs',
  expectedSourceGitSha: '0123456789abcdef0123456789abcdef01234567',
  trustedNodePath: '/absolute/path/to/node',
  trustedHermesVersion: '0.30.0',
});
```

Update and rollback validate artifact provenance, compatibility, package identity, closure digests, and the exact entry point before activation. A failed validation leaves the current config unchanged.

## Status, uninstall, and reset

Use the exported helpers:

- `hermesLucyStatus`
- `uninstallHermesLucyConfig`
- `resetHermesLucyBackup`
- `resetHermesLucyArtifacts`

Uninstall removes only the managed Lucy entry and preserves unrelated YAML keys. Backup reset removes the first-install backup; artifact reset manages cached artifacts according to the helper's documented return value.

Never place a raw token in source code, YAML committed to Git, a receipt, or an artifact manifest.
