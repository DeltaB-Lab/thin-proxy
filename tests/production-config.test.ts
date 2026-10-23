import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productionConfig, writeProductionConfig } from '../scripts/production-config.mjs';

const deployment = {
  DEPLOY_WORKER_NAME: 'existing-relay',
  DEPLOY_ACCOUNT_ID: 'a'.repeat(32),
  DEPLOY_DATABASE_NAME: 'existing-database',
  DEPLOY_DATABASE_ID: '11111111-2222-3333-4444-555555555555',
  DEPLOY_CUSTOM_DOMAIN: 'relay.example.com',
  DEPLOY_SELF_HOSTS: 'relay.example.com,existing-relay.example.workers.dev'
};
const template = {
  name: 'thin-proxy', workers_dev: true, preview_urls: false, main: 'src/index.ts',
  compatibility_date: '2026-08-06', assets: { directory: './dist', binding: 'ASSETS' },
  d1_databases: [{ binding: 'DB', database_name: 'thin-proxy', database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }],
  vars: { CONFIG_CACHE_TTL_SECONDS: '30', SELF_HOSTS: '' }, observability: { enabled: true }
};

describe('existing production deployment', () => {
  it('keeps the existing database and private ingress while preserving shared runtime settings', () => {
    const result = productionConfig(template, { ...deployment, ADMIN_KEY: 'runtime-secret', UPSTREAM_KEY_ENCRYPTION_KEY: 'encryption-secret', CLOUDFLARE_API_TOKEN: 'api-secret' });
    expect(result).toEqual({
      ...template, name: deployment.DEPLOY_WORKER_NAME, account_id: deployment.DEPLOY_ACCOUNT_ID,
      workers_dev: false, preview_urls: false,
      routes: [{ pattern: deployment.DEPLOY_CUSTOM_DOMAIN, custom_domain: true }],
      d1_databases: [{ ...template.d1_databases[0], database_id: deployment.DEPLOY_DATABASE_ID, database_name: deployment.DEPLOY_DATABASE_NAME }],
      vars: { ...template.vars, SELF_HOSTS: deployment.DEPLOY_SELF_HOSTS }
    });
    expect(template.workers_dev).toBe(true);
    expect(template.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each(Object.keys(deployment))('stops rather than falling back to the public template without %s', name => {
    expect(() => productionConfig(template, { ...deployment, [name]: '' })).toThrow(name);
  });

  it.each([
    ['DEPLOY_DATABASE_ID', '00000000-0000-0000-0000-000000000000'],
    ['DEPLOY_ACCOUNT_ID', 'not-an-account'],
    ['DEPLOY_DATABASE_ID', 'not-a-database'],
    ['DEPLOY_CUSTOM_DOMAIN', 'https://relay.example.com/path'],
    ['DEPLOY_SELF_HOSTS', 'other.example.com'],
    ['DEPLOY_SELF_HOSTS', 'relay.example.com,https://alias.example.com']
  ])('rejects invalid deployment identity or loop protection: %s', (name, value) => {
    expect(() => productionConfig(template, { ...deployment, [name]: value })).toThrow(name);
  });

  it('rejects unexpected database bindings instead of deploying additional template databases', () => {
    expect(() => productionConfig({ ...template, d1_databases: [] }, deployment)).toThrow('exactly one');
    expect(() => productionConfig({ ...template, d1_databases: [...template.d1_databases, { binding: 'OTHER' }] }, deployment)).toThrow('exactly one');
  });
});

let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'thin-proxy-production-'));
  await writeFile(join(directory, 'wrangler.jsonc'), '// Public deployment template\n' + JSON.stringify(template));
  await writeFile(join(directory, '.env'), Object.entries({ ...deployment, ADMIN_KEY: 'do-not-copy', UPSTREAM_KEY_ENCRYPTION_KEY: 'do-not-copy-either' }).map(([key, value]) => `${key}=${value}`).join('\n'));
}

it('loads local settings with explicit environment overrides, without modifying the template or secret file', async () => {
  await fixture();
  const envBefore = await readFile(join(directory, '.env'), 'utf8');
  const templateBefore = await readFile(join(directory, 'wrangler.jsonc'), 'utf8');
  const target = await writeProductionConfig(directory, { DEPLOY_WORKER_NAME: 'override-relay' });
  const generated = await readFile(target, 'utf8');
  expect(JSON.parse(generated).name).toBe('override-relay');
  expect(generated).not.toContain('do-not-copy');
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(directory, '.env'), 'utf8')).toBe(envBefore);
  expect(await readFile(join(directory, 'wrangler.jsonc'), 'utf8')).toBe(templateBefore);
});

it.each(['CI', 'WORKERS_CI'])('requires configured build variables in %s, ignoring local .env', async name => {
  await fixture();
  await expect(writeProductionConfig(directory, { [name]: '1' })).rejects.toThrow('DEPLOY_WORKER_NAME');
  await expect(stat(join(directory, '.wrangler.production.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const target = await writeProductionConfig(directory, { ...deployment, [name]: '1' });
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(productionConfig(template, deployment));
});

it('refuses malformed JSONC before writing a deployable configuration', async () => {
  await fixture();
  await writeFile(join(directory, 'wrangler.jsonc'), '{broken');
  await expect(writeProductionConfig(directory, deployment)).rejects.toThrow('Invalid wrangler.jsonc');
  await expect(stat(join(directory, '.wrangler.production.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
