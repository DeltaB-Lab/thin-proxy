export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public headers?: Record<string, string>) {
    super(message);
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    const response = json({ error: { code: error.code, message: error.message } }, error.status);
    for (const [name, value] of Object.entries(error.headers ?? {})) response.headers.set(name, value);
    return response;
  }
  // Never serialize exceptions: Fetch/D1 errors can contain credentials or URLs.
  return json({ error: { code: 'INTERNAL_ERROR', message: '内部错误，请检查部署配置' } }, 500);
}
