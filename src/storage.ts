import { HttpError } from './errors';
import type { Config, Env, Snapshot } from './types';
export function snapshot(version: number, config: Config): Snapshot {
  if (!Number.isInteger(version) || !Array.isArray(config.upstreams) || !Array.isArray(config.accessKeys) ||
    (config.activeUpstreamId !== null && !config.upstreams.some(u => u.id === config.activeUpstreamId))) {
    throw new Error('Invalid stored configuration');
  }
  return { version, config, keyHashes: new Set(config.accessKeys.map(k => k.keyHash)) };
}
export async function readConfig(env: Env): Promise<Snapshot> {
  try {
    const row = await env.DB.withSession('first-primary').prepare(
      'SELECT version, config_json FROM config WHERE id = 1'
    ).first<{ version: number; config_json: string }>();
    if (!row) throw new Error();
    return snapshot(row.version, JSON.parse(row.config_json));
  } catch {
    throw new HttpError(503, 'CONFIG_UNAVAILABLE', '配置读取失败，请检查 D1 绑定及迁移');
  }
}
export async function writeConfig(env: Env, expectedVersion: number, config: Config): Promise<Snapshot> {
  const next = snapshot(expectedVersion + 1, config);
  let changes: number;
  try {
    const result = await env.DB.withSession('first-primary').prepare(
      'UPDATE config SET config_json = ?, version = version + 1, updated_at = ? WHERE id = 1 AND version = ?'
    ).bind(JSON.stringify(config), new Date().toISOString(), expectedVersion).run();
    changes = result.meta.changes;
  } catch {
    throw new HttpError(503, 'CONFIG_UNAVAILABLE', '配置保存失败');
  }
  if (changes !== 1) throw new HttpError(409, 'VERSION_CONFLICT', '配置已被其他操作修改，请刷新后重试');
  return next;
}
