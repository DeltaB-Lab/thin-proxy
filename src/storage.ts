import { HttpError } from './errors';
import type { Config, Env, Snapshot } from './types';
// Normalize old ordered bindings once per cached read. No migration write is
// needed: the next explicit configuration edit persists the normalized shape.
export function snapshot(version: number, input: Config): Snapshot {
  if (!Number.isInteger(version) || !input || !Array.isArray(input.upstreams) || !Array.isArray(input.accessKeys)) {
    throw new Error('Invalid stored configuration');
  }
  const config: Config = {
    activeUpstreamId: input.activeUpstreamId,
    upstreams: input.upstreams.map(value => {
      const { healthRevision, faultUntil, faultReason, ...upstream } = value as typeof value & Record<string, unknown>;
      return upstream;
    }),
    accessKeys: input.accessKeys.map(value => {
      const { upstreamIds, failoverEnabled, ...key } = value as typeof value & Record<string, unknown>;
      if (upstreamIds !== undefined) {
        if (upstreamIds !== null && (!Array.isArray(upstreamIds) || !upstreamIds.length ||
          upstreamIds.some(id => typeof id !== 'string' || !id))) throw new Error('Invalid stored configuration');
        key.upstreamId = upstreamIds === null ? null : (upstreamIds as string[])[0];
      }
      key.upstreamId ??= null;
      return key;
    })
  };
  if (config.upstreams.some(u => u.modelCatalogUrl !== undefined && typeof u.modelCatalogUrl !== 'string') ||
    (config.activeUpstreamId !== null && !config.upstreams.some(u => u.id === config.activeUpstreamId)) ||
    config.accessKeys.some(k => (k.enabled !== undefined && typeof k.enabled !== 'boolean') ||
      (k.upstreamId != null && (typeof k.upstreamId !== 'string' || !config.upstreams.some(u => u.id === k.upstreamId))))) {
    throw new Error('Invalid stored configuration');
  }
  return { version, config, keysByHash: new Map(config.accessKeys.map(k => [k.keyHash, k])) };
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
    ).bind(JSON.stringify(next.config), new Date().toISOString(), expectedVersion).run();
    changes = result.meta.changes;
  } catch {
    throw new HttpError(503, 'CONFIG_UNAVAILABLE', '配置保存失败');
  }
  if (changes !== 1) throw new HttpError(409, 'VERSION_CONFLICT', '配置已被其他操作修改，请刷新后重试');
  return next;
}
