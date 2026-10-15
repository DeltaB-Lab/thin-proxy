import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const supportedVersion = '4.151.0';
const original = [
  'function getListAppliedMigrationsQuery(migrationsTableName) {',
  '  const escapedTableName = escapeIdentifier(migrationsTableName);',
  '  return `SELECT *',
  '\t\tFROM ${escapedTableName}',
  '\t\tORDER BY id`;',
  '}'
].join('\n');
const patched = original.replace('SELECT *', 'SELECT id, name, applied_at');

// Keep Wrangler's migration ordering, transactions and history compatibility.
// Fail closed on dependency changes instead of silently running wildcard SQL.
export function patchMigrationQuery(source, version) {
  if (version !== supportedVersion) throw new Error(`D1 migration patch requires Wrangler ${supportedVersion}; review the patch before upgrading.`);
  const originalCount = source.split(original).length - 1;
  const patchedCount = source.split(patched).length - 1;
  if (originalCount === 0 && patchedCount === 1) return source;
  if (originalCount !== 1 || patchedCount !== 0) throw new Error('Wrangler migration query changed; refusing to run without the explicit-column patch.');
  return source.replace(original, patched);
}

export async function patchWrangler() {
  const packagePath = require.resolve('wrangler/package.json');
  const { version } = JSON.parse(await readFile(packagePath, 'utf8'));
  const cliPath = join(dirname(packagePath), 'wrangler-dist', 'cli.js');
  const source = await readFile(cliPath, 'utf8');
  const result = patchMigrationQuery(source, version);
  if (result === source) return;
  const temporaryPath = `${cliPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, result, { flag: 'wx' });
    await rename(temporaryPath, cliPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchWrangler();
  console.log('Wrangler D1 migration query verified: explicit columns only.');
}
