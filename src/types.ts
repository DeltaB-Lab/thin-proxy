export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_KEY: string;
  ADMIN_LOGIN_LIMITER: RateLimit;
  UPSTREAM_KEY_ENCRYPTION_KEY: string;
  CONFIG_CACHE_TTL_SECONDS?: string;
  UPSTREAM_TIMEOUT_SECONDS?: string;
  SELF_HOSTS?: string;
}
export type AuthType = 'bearer' | 'x-api-key';
export interface EncryptedKey {
  keyCiphertext: string;
  keyIv: string;
  keyVersion: number;
}
export interface Upstream extends EncryptedKey {
  id: string;
  name: string;
  baseUrl: string;
  modelCatalogUrl?: string;
  authType: AuthType;
}
export interface AccessKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  createdAt: string;
  upstreamId?: string | null;
  // Older keys remain enabled until explicitly stopped.
  enabled?: boolean;
  encryptedKey?: EncryptedKey;
}
export interface Config {
  activeUpstreamId: string | null;
  upstreams: Upstream[];
  accessKeys: AccessKey[];
}
export interface Snapshot {
  version: number;
  config: Config;
  keysByHash: ReadonlyMap<string, AccessKey>;
}
