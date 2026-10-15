export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_KEY: string;
  UPSTREAM_KEY_ENCRYPTION_KEY: string;
  CONFIG_CACHE_TTL_SECONDS?: string;
  UPSTREAM_TIMEOUT_SECONDS?: string;
  UPSTREAM_COOLDOWN_SECONDS?: string;
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
  authType: AuthType;
  healthRevision?: number;
  faultUntil?: number;
  faultReason?: string | null;
}
export interface AccessKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  createdAt: string;
  // Read-only compatibility with earlier single-upstream configurations.
  upstreamId?: string | null;
  upstreamIds?: string[] | null;
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
