import { HttpError } from './errors';

export const MAX_REPLAY_BYTES = 8 * 1024 * 1024;

export function requireConnected(signal: AbortSignal): void {
  if (signal.aborted) throw new HttpError(499, 'CLIENT_CLOSED_REQUEST', '客户端已取消请求');
}

// Buffer raw bytes only for multi-upstream requests. Never parse business payloads
// or use clone()/tee(), whose unread branches can grow without a bound.
export async function replayBody(request: Request): Promise<() => ReadableStream<Uint8Array> | undefined> {
  requireConnected(request.signal);
  if (!request.body) return () => undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  const blockSize = 64 * 1024;
  let used = blockSize;
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  request.signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      requireConnected(request.signal);
      const { value, done } = await reader.read();
      requireConnected(request.signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLAY_BYTES) {
        cancel();
        throw new HttpError(413, 'REPLAY_BODY_TOO_LARGE', '多上游故障转移的请求体最多为 8 MiB，请缩小请求或为此 Key 仅配置一个上游');
      }
      // Coalesce small chunks so the bookkeeping is bounded as well as the bytes.
      for (let offset = 0; offset < value.byteLength;) {
        if (used === blockSize) { chunks.push(new Uint8Array(blockSize)); used = 0; }
        const count = Math.min(blockSize - used, value.byteLength - offset);
        chunks[chunks.length - 1].set(value.subarray(offset, offset + count), used);
        offset += count; used += count;
      }
    }
  } finally {
    request.signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  if (chunks.length) chunks[chunks.length - 1] = chunks[chunks.length - 1].subarray(0, used);
  return () => {
    let index = 0;
    return new ReadableStream({ pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    } });
  };
}
