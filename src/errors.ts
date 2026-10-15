export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  // Never serialize exceptions: Fetch/D1 errors can contain credentials or URLs.
  return json({ error: { code: 'INTERNAL_ERROR', message: '内部错误，请检查部署配置' } }, 500);
}
