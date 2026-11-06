import { hash } from './crypto';
import { HttpError } from './errors';
import type { Env } from './types';

export async function requireLoginAllowance(request: Request, env: Env): Promise<void> {
  // Cloudflare supplies this header at ingress. Never use user-controlled XFF.
  // Include the deployment secret so template copies sharing a namespace do not
  // share counters. Neither the IP address nor the secret leaves the Worker.
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const key = await hash(`worker-relay/admin-login/v1\0${env.ADMIN_KEY}\0${ip}`);
  let success: boolean;
  try {
    ({ success } = await env.ADMIN_LOGIN_LIMITER.limit({ key }));
  } catch {
    throw new HttpError(503, 'LOGIN_UNAVAILABLE', '管理登录暂不可用，请检查限速绑定');
  }
  if (!success) throw new HttpError(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请一分钟后重试', { 'Retry-After': '60' });
}
