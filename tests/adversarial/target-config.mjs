import { pathToFileURL } from 'node:url';

const REQUIRED_STAGING = [
  'LUCY_ADVERSARIAL_ADAPTER_MODULE',
  'LUCY_ADVERSARIAL_BASE_URL',
  'LUCY_ADVERSARIAL_AUDIENCE',
  'LUCY_ADVERSARIAL_WORKSPACE_A',
  'LUCY_ADVERSARIAL_WORKSPACE_B',
  'LUCY_ADVERSARIAL_CONNECTOR_SHA',
  'LUCY_ADVERSARIAL_SERVICE_SHA',
  'LUCY_ADVERSARIAL_HARNESS_SHA',
];

function productionLike(value) {
  return /(?:^|[._-])(prod|production)(?:$|[._-])/i.test(value);
}

export function stagingConfig(env = process.env) {
  const missing = REQUIRED_STAGING.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Staging adversarial target is incomplete: ${missing.join(', ')}`);
  if (env.LUCY_ADVERSARIAL_DISPOSABLE !== 'true') {
    throw new Error('Staging adversarial writes require LUCY_ADVERSARIAL_DISPOSABLE=true.');
  }
  const url = new URL(env.LUCY_ADVERSARIAL_BASE_URL);
  if (url.protocol !== 'https:') throw new Error('Staging adversarial target must use HTTPS.');
  const guarded = [url.hostname, env.LUCY_ADVERSARIAL_WORKSPACE_A, env.LUCY_ADVERSARIAL_WORKSPACE_B];
  if (guarded.some(productionLike)) throw new Error('Production-like targets are forbidden.');
  if (env.LUCY_ADVERSARIAL_WORKSPACE_A === env.LUCY_ADVERSARIAL_WORKSPACE_B) {
    throw new Error('Two distinct disposable workspaces are required.');
  }
  return {
    kind: 'staging',
    baseUrl: url.href,
    audience: env.LUCY_ADVERSARIAL_AUDIENCE,
    workspaces: [env.LUCY_ADVERSARIAL_WORKSPACE_A, env.LUCY_ADVERSARIAL_WORKSPACE_B],
    adapterModule: env.LUCY_ADVERSARIAL_ADAPTER_MODULE,
    shas: {
      connector: env.LUCY_ADVERSARIAL_CONNECTOR_SHA,
      service: env.LUCY_ADVERSARIAL_SERVICE_SHA,
      harness: env.LUCY_ADVERSARIAL_HARNESS_SHA,
    },
  };
}

export async function loadStagingAdapter(config, context) {
  const moduleUrl = /^[a-z]+:/i.test(config.adapterModule)
    ? config.adapterModule
    : pathToFileURL(config.adapterModule).href;
  const loaded = await import(moduleUrl);
  if (typeof loaded.createAdversarialTarget !== 'function') {
    throw new Error('Staging adapter must export createAdversarialTarget(config, context).');
  }
  return loaded.createAdversarialTarget(config, context);
}
