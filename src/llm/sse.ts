// 轻量 SSE (Server-Sent Events) 解析器
// Provider 调用 fetch() 拿到 ReadableStream<Uint8Array> 后，
// 用 iterateSse 把数据流切成 {event?, data} 事件。

export interface SseEvent {
  event?: string;
  data: string;
}

/** 逐条产出 SSE 事件 */
export async function* iterateSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = findBlankLine(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^(\r?\n){1,2}/, '');
        const evt = parseSseEvent(rawEvent);
        if (evt) yield evt;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const evt = parseSseEvent(buffer);
      if (evt) yield evt;
    }
  } finally {
    reader.releaseLock();
  }
}

function findBlankLine(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseSseEvent(raw: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join('\n') };
}
