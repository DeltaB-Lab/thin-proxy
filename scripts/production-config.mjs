import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { parse } from 'jsonc-parser';

const hostname = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
function required(env, name, pattern) {
  const value = env[name]?.trim();
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Missing or invalid ${name}; production deployment stopped.`);
  return value;
}

export function productionConfig(template, env) {
  const config = structuredClone(template);
  config.name = required(env, 'DEPLOY_WORKER_NAME', /^[a-z0-9][a-z0-9-]{0,62}$/);
  config.account_id = required(env, 'DEPLOY_ACCOUNT_ID', /^[a-f0-9]{32}$/i);
  const databaseName = required(env, 'DEPLOY_DATABASE_NAME', /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
  const databaseId = required(env, 'DEPLOY_DATABASE_ID', /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
  if (databaseId === '00000000-0000-0000-0000-000000000000') throw new Error('DEPLOY_DATABASE_ID must identify an existing production database.');
  const domain = required(env, 'DEPLOY_CUSTOM_DOMAIN', hostname).toLowerCase();
  const selfHosts = required(env, 'DEPLOY_SELF_HOSTS').split(',').map(host => host.trim().toLowerCase());
  if (selfHosts.some(host => !hostname.test(host)) || !selfHosts.includes(domain)) {
    throw new Error('DEPLOY_SELF_HOSTS must contain valid hostnames including DEPLOY_CUSTOM_DOMAIN.');
  }
  const database = config.d1_databases?.find(binding => binding.binding === 'DB');
  if (!database || config.d1_databases.length !== 1) throw new Error('Expected exactly one D1 binding named DB.');
  Object.assign(database, { database_id: databaseId, database_name: databaseName });
  config.routes = [{ pattern: domain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  config.vars = { ...config.vars, SELF_HOSTS: selfHosts.join(',') };
  return config;
}

export async function writeProductionConfig(directory = process.cwd(), environment = process.env) {
  let local = {};
  // CI must use its build settings; never fall back to a copied local secret file.
  if (!environment.CI && !environment.WORKERS_CI) {
    try { local = parseEnv(await readFile(resolve(directory, '.env'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const errors = [];
  const template = parse(await readFile(resolve(directory, 'wrangler.jsonc'), 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !template || typeof template !== 'object') throw new Error('Invalid wrangler.jsonc; production deployment stopped.');
  const config = productionConfig(template, { ...local, ...environment });
  // Only the explicitly selected deployment fields enter this file, never runtime secrets.
  const target = resolve(directory, '.wrangler.production.json');
  await writeFile(target, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeProductionConfig();
  console.log('Production configuration prepared in .wrangler.production.json (ignored by Git).');
}
