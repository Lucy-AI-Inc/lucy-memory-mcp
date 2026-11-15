import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLucyHttpTransport } from '../client/http-transport.mjs';
import { McpLifecycleError, runLifecycleStage } from './lifecycle.mjs';

const PUBLIC_PERMISSIONS = new Set(['memory:read', 'memory:propose']);
const configurationError = () => new McpLifecycleError('CONFIGURATION_ERROR');
const optionalPositiveInteger = (value) => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw configurationError();
  return parsed;
};
const validateModulePath = (value) => (
  typeof value === 'string' && value.length > 0 && !/[\r\n\0]/.test(value)
  && (value.startsWith('file:') || isAbsolute(value))
);

export function loadLucyMemoryMcpConfig(environment = process.env) {
  const token = environment.LUCY_MEMORY_TOKEN;
  if (typeof token !== 'string' || token.length === 0 || /[\r\n\0]/.test(token)) throw configurationError();
  const permissions = String(environment.LUCY_MEMORY_PERMISSIONS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (permissions.length === 0 || new Set(permissions).size !== permissions.length
      || permissions.some((permission) => !PUBLIC_PERMISSIONS.has(permission))) throw configurationError();
  const timeoutMs = Number(environment.LUCY_MEMORY_TIMEOUT_MS ?? 10_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw configurationError();
  const insecureLoopbackSetting = environment.LUCY_MEMORY_ALLOW_INSECURE_LOOPBACK;
  if (insecureLoopbackSetting !== undefined && insecureLoopbackSetting !== 'true' && insecureLoopbackSetting !== 'false') throw configurationError();
  const allowInsecureLoopback = insecureLoopbackSetting === 'true';
  const baseUrl = environment.LUCY_MEMORY_BASE_URL;
  const transportModule = environment.LUCY_MEMORY_TRANSPORT_MODULE;
  const admissionModule = environment.LUCY_MEMORY_ADMISSION_MODULE;
  const maxBodyBytes = optionalPositiveInteger(environment.LUCY_MEMORY_MAX_BODY_BYTES);
  const maxConcurrentPerTask = optionalPositiveInteger(environment.LUCY_MEMORY_MAX_CONCURRENT_PER_TASK);
  const hasBase = typeof baseUrl === 'string' && baseUrl.length > 0;
  const hasModule = typeof transportModule === 'string' && transportModule.length > 0;
  if (hasBase === hasModule) throw configurationError();
  if (hasBase && /[\r\n\0]/.test(baseUrl)) throw configurationError();
  if (hasModule && !validateModulePath(transportModule)) {
    throw configurationError();
  }
  if (admissionModule !== undefined && !validateModulePath(admissionModule)) throw configurationError();
  return Object.freeze({
    token,
    permissions: Object.freeze(permissions),
    timeoutMs,
    allowInsecureLoopback,
    admission: Object.freeze({
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      ...(maxConcurrentPerTask === undefined ? {} : { maxConcurrentPerTask }),
    }),
    ...(admissionModule === undefined ? {} : { admissionModule }),
    ...(hasBase ? { baseUrl } : { transportModule }),
  });
}

export async function loadAgentMemoryTransport(moduleSpecifier) {
  return runLifecycleStage('TRANSPORT_LOAD_ERROR', async () => {
    const url = moduleSpecifier.startsWith('file:') ? new URL(moduleSpecifier) : pathToFileURL(moduleSpecifier);
    if (url.protocol !== 'file:') throw new Error('unsupported protocol');
    const loaded = await import(url.href);
    const factory = loaded.createTransport ?? loaded.default;
    if (typeof factory !== 'function') throw new Error('missing transport factory');
    const transport = await factory();
    if (typeof transport !== 'function') throw new Error('invalid transport factory result');
    return transport;
  });
}

export async function resolveLucyMemoryTransport(config) {
  if (config.baseUrl) return createLucyHttpTransport({
    baseUrl: config.baseUrl,
    allowInsecureLoopback: config.allowInsecureLoopback,
  });
  return loadAgentMemoryTransport(config.transportModule);
}

export async function resolveLucyMemoryAdmission(config) {
  if (!config.admissionModule) return Object.freeze({ admission: config.admission });
  return runLifecycleStage('ADMISSION_LOAD_ERROR', async () => {
    const url = config.admissionModule.startsWith('file:')
      ? new URL(config.admissionModule)
      : pathToFileURL(config.admissionModule);
    if (url.protocol !== 'file:') throw new Error('unsupported protocol');
    const loaded = await import(url.href);
    const factory = loaded.createAdmission ?? loaded.default;
    if (typeof factory !== 'function') throw new Error('missing admission factory');
    const resolved = await factory();
    if (resolved === null || typeof resolved !== 'object'
      || resolved.admission === null || typeof resolved.admission !== 'object'
      || resolved.admission.authority === null
      || typeof resolved.admission.authority?.acquire !== 'function'
      || typeof resolved.admission.authority?.release !== 'function') {
      throw new Error('invalid admission factory result');
    }
    return Object.freeze({
      admission: Object.freeze({ ...config.admission, ...resolved.admission }),
      ...(typeof resolved.onOperabilityEvent === 'function'
        ? { onOperabilityEvent: resolved.onOperabilityEvent }
        : {}),
    });
  });
}
