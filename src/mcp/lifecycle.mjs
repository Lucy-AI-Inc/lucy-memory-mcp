const SAFE_MESSAGES = Object.freeze({
  CONFIGURATION_ERROR: 'Lucy Memory MCP configuration is invalid.',
  TRANSPORT_LOAD_ERROR: 'Lucy Memory MCP transport could not be loaded.',
  STARTUP_ERROR: 'Lucy Memory MCP could not start.',
  SHUTDOWN_ERROR: 'Lucy Memory MCP could not shut down cleanly.',
});

export class McpLifecycleError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? SAFE_MESSAGES.STARTUP_ERROR);
    this.name = 'McpLifecycleError';
    this.code = Object.hasOwn(SAFE_MESSAGES, code) ? code : 'STARTUP_ERROR';
  }
}

export function safeLifecycleDiagnostic(error, fallback = 'STARTUP_ERROR') {
  const fallbackCode = Object.hasOwn(SAFE_MESSAGES, fallback) ? fallback : 'STARTUP_ERROR';
  const code = error instanceof McpLifecycleError && Object.hasOwn(SAFE_MESSAGES, error.code) ? error.code : fallbackCode;
  return `${code}: ${SAFE_MESSAGES[code]}\n`;
}

export async function runLifecycleStage(code, action) {
  try {
    return await action();
  } catch {
    throw new McpLifecycleError(code);
  }
}

export function createShutdownController({ close, writeDiagnostic, setExitCode }) {
  if (typeof close !== 'function' || typeof writeDiagnostic !== 'function' || typeof setExitCode !== 'function') {
    throw new TypeError('Shutdown controller dependencies must be functions.');
  }
  let pending;
  return function shutdown() {
    if (pending) return pending;
    pending = (async () => {
      try {
        await close();
        setExitCode(0);
        return true;
      } catch {
        writeDiagnostic(safeLifecycleDiagnostic(new McpLifecycleError('SHUTDOWN_ERROR'), 'SHUTDOWN_ERROR'));
        setExitCode(1);
        return false;
      }
    })();
    return pending;
  };
}
