import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
// Never overwrite credentials: the encryption key may already protect stored upstreams.
try {
  const env = parseEnv(await readFile('.env', 'utf8'));
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 32 || !env.UPSTREAM_KEY_ENCRYPTION_KEY || Buffer.from(env.UPSTREAM_KEY_ENCRYPTION_KEY, 'base64').length !== 32) {
    throw new Error('.env is incomplete or invalid. Restore both original keys from your backup; existing credentials were not changed.');
  }
  console.log('.env already exists; credentials preserved.');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  const value = `ADMIN_KEY=${randomBytes(32).toString('base64url')}\nUPSTREAM_KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`;
  await writeFile('.env', value, { flag: 'wx', mode: 0o600 });
  console.log('Created .env. Keep this file private; copy it to your new computer before initializing if you want to keep existing keys.');
}
