// LLM 请求重试工具
// 仅在"流开始前的 HTTP 层"做重试：一旦服务端开始 200 流式响应，就不能再重试
// 触发重试的条件：429 / 5xx（除 501 Not Implemented）/ fetch 抛 TypeError（常见于临时网络抖动）

const DEFAULT_MAX_RETRIES = 2;
const BASE_DELAY_MS = 800;

export interface FetchRetryOptions extends RequestInit {
  /** 最大重试次数（不含首次），默认 2，共计最多 3 次 */
  maxRetries?: number;
  /** 判定是否应该重试，若给出会覆盖默认逻辑 */
  shouldRetry?: (resp: Response | null, err: unknown) => boolean;
}

/**
 * 带自动重试的 fetch。
 * 注意：此函数只处理"首次响应"的重试，一旦取到 Response 对象就会直接返回（不会重试流中断）。
 */
export async function fetchWithRetry(
  url: string,
  opts: FetchRetryOptions = {},
): Promise<Response> {
  const { maxRetries = DEFAULT_MAX_RETRIES, shouldRetry, ...init } = opts;
  const signal = init.signal ?? undefined;

  let lastError: unknown = null;
  let lastResp: Response | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('请求已取消', 'AbortError');
    }

    try {
      const resp = await fetch(url, init);
      lastResp = resp;
      const retry = shouldRetry
        ? shouldRetry(resp, null)
        : defaultShouldRetry(resp, null);
      if (!retry || attempt === maxRetries) return resp;
    } catch (err) {
      if (signal?.aborted || (err as any)?.name === 'AbortError') throw err;
      lastError = err;
      const retry = shouldRetry
        ? shouldRetry(null, err)
        : defaultShouldRetry(null, err);
      if (!retry || attempt === maxRetries) throw err;
    }

    // 指数退避 + 少量抖动
    const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 200;
    await sleepWithAbort(delay, signal);
  }

  if (lastResp) return lastResp;
  if (lastError) throw lastError;
  throw new Error('fetchWithRetry 意外退出');
}

function defaultShouldRetry(resp: Response | null, err: unknown): boolean {
  if (err) {
    // 典型的网络层错误：fetch 抛 TypeError("Failed to fetch")
    return err instanceof TypeError;
  }
  if (!resp) return false;
  if (resp.status === 429) return true;
  if (resp.status >= 500 && resp.status < 600 && resp.status !== 501) return true;
  return false;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('请求已取消', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException('请求已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
