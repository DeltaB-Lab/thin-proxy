import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { patchMigrationQuery, patchWrangler } from '../scripts/patch-wrangler.mjs';

const require = createRequire(import.meta.url);
const wranglerRoot = dirname(require.resolve('wrangler/package.json'));
const exec = promisify(execFile);
let source: string;
let directory: string;

beforeAll(async () => {
  await patchWrangler();
  source = await readFile(join(wranglerRoot, 'wrangler-dist/cli.js'), 'utf8');
  directory = await mkdtemp(join(tmpdir(), 'thin-proxy-migrations-'));
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('Wrangler migration query patch', () => {
  it('replaces only the wildcard projection and remains idempotent', () => {
    const original = source.replace('return `SELECT id, name, applied_at\n\t\tFROM ${escapedTableName}', 'return `SELECT *\n\t\tFROM ${escapedTableName}');
    expect(original).not.toBe(source);
    expect(patchMigrationQuery(original, '4.151.0')).toBe(source);
    expect(patchMigrationQuery(source, '4.151.0')).toBe(source);
    const queryFunction = source.match(/function getListAppliedMigrationsQuery\(migrationsTableName\) \{[\s\S]*?\n\}/)![0];
    const query = runInNewContext(`${queryFunction}; getListAppliedMigrationsQuery('d1_migrations')`, {
      escapeIdentifier: (name: string) => `"${name.replace(/"/g, '""')}"`
    });
    expect(query.replace(/\s+/g, ' ')).toBe('SELECT id, name, applied_at FROM "d1_migrations" ORDER BY id');
  });

  it('blocks unreviewed versions, changed helpers and ambiguous matches', () => {
    expect(() => patchMigrationQuery(source, '4.152.0')).toThrow('review the patch');
    expect(() => patchMigrationQuery(source.replace('SELECT id, name, applied_at', 'SELECT name'), '4.151.0')).toThrow('refusing to run');
    expect(() => patchMigrationQuery(source + source, '4.151.0')).toThrow('refusing to run');
  });
});

async function wrangler(...args: string[]) {
  return exec(process.execPath, [join(wranglerRoot, 'bin/wrangler.js'), 'd1', ...args,
    '--local', '--config', join(directory, 'wrangler.json'), '--persist-to', join(directory, 'state')], {
    cwd: directory,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: join(directory, 'logs') },
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
}

it('applies migrations locally, preserves existing history on reruns, and rolls back failed migrations', async () => {
  await mkdir(join(directory, 'migrations'));
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify({
    name: 'migration-test', compatibility_date: '2026-08-06',
    d1_databases: [{ binding: 'DB', database_name: 'migration-test', database_id: '00000000-0000-0000-0000-000000000001' }]
  }));
  await writeFile(join(directory, 'migrations/0001_config.sql'), await readFile(resolve('migrations/0001_config.sql')));
  await wrangler('migrations', 'apply', 'DB');
  await wrangler('execute', 'DB', '--command', 'UPDATE config SET version = 41 WHERE id = 1');
  const rerun = await wrangler('migrations', 'apply', 'DB');
  expect(rerun.stdout).toContain('No migrations to apply');
  await writeFile(join(directory, 'migrations/0002_failure.sql'), 'CREATE TABLE must_rollback (id INTEGER); INSERT INTO missing_table (id) VALUES (1);');
  await expect(wrangler('migrations', 'apply', 'DB')).rejects.toMatchObject({ code: 1 });
  const result = await wrangler('execute', 'DB', '--json', '--command',
    "SELECT name FROM d1_migrations ORDER BY id; SELECT version FROM config WHERE id = 1; SELECT name FROM sqlite_schema WHERE name = 'must_rollback';");
  const queries = JSON.parse(result.stdout);
  expect(queries.map((query: {results: unknown[]}) => query.results)).toEqual([
    [{ name: '0001_config.sql' }], [{ version: 41 }], []
  ]);
}, 60_000);
