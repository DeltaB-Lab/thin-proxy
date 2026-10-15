import { admin } from './admin';
import { errorResponse } from './errors';
import { proxy } from './proxy';
import type { Env } from './types';

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/_relay') return Response.redirect(`${new URL(request.url).origin}/_relay/`, 308);
      if (path === '/_relay/api' || path.startsWith('/_relay/api/')) {
        return await admin(request, env);
      }
      if (path.startsWith('/_relay/')) {
        const asset = await env.ASSETS.fetch(request);
        const response = new Response(asset.body, asset);
        response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('Referrer-Policy', 'no-referrer');
        response.headers.set('Cache-Control', 'no-store');
        return response;
      }
      return await proxy(request, env, context);
    } catch (error) { return errorResponse(error); }
  }
} satisfies ExportedHandler<Env>;
