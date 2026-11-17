import { createHmac } from 'node:crypto';

export function hostedIdentityHash(key, value) {
  if (typeof key !== 'string' || typeof value !== 'string') return null;
  return `h1:${createHmac('sha256', key).update(value, 'utf8').digest('base64url')}`;
}

export function emitHostedMcpLog(logger, event) {
  try {
    logger(Object.freeze({ ...event }));
  } catch {
    // Logging must never change request behavior.
  }
}

export function defaultHostedMcpLogger(event) {
  console.log(JSON.stringify(event));
}
