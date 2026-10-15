import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
// Never overwrite existing credentials or print them into logs.
const value = `ADMIN_KEY=${randomBytes(32).toString('base64url')}\nUPSTREAM_KEY_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`;
try {
  await writeFile('.dev.vars', value, { flag: 'wx', mode: 0o600 });
  console.log('Created .dev.vars with local-only random secrets. Open this file locally to copy ADMIN_KEY.');
} catch (e) {
  if (e.code === 'EEXIST') console.log('.dev.vars already exists; credentials preserved.');
  else throw e;
}
