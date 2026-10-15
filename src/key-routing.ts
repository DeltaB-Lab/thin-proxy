import type { AccessKey } from './types';

// null means follow the global default. Explicit lists never append other routes.
export function keyUpstreamIds(key: AccessKey): string[] | null {
  if (key.upstreamIds !== undefined) return key.upstreamIds;
  return key.upstreamId == null ? null : [key.upstreamId];
}
