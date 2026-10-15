export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_KEY: string;
  UPSTREAM_KEY_ENCRYPTION_KEY: string;
  CONFIG_CACHE_TTL_SECONDS?: string;
  SELF_HOSTS?: string;
}
export type AuthType = 'bearer' | 'x-api-key';
export interface Upstream {
  id: string;
  name: string;
  baseUrl: string;
  authType: AuthType;
  keyCiphertext: string;
  keyIv: string;
  keyVersion: number;
}
export interface AccessKey {
  id: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  createdAt: string;
}
export interface Config {
  activeUpstreamId: string | null;
  upstreams: Upstream[];
  accessKeys: AccessKey[];
}
export interface Snapshot {
  version: number;
  config: Config;
  keyHashes: ReadonlySet<string>;
}
