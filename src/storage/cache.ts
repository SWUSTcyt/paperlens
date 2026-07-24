// 会话级结果缓存：按页面 URL 缓存"抽取 + 解读 + 推导"结果
//
// 使用 chrome.storage.session：
//   - 侧边栏关闭再打开、切换标签页再切回，都能恢复该论文已生成的内容
//   - 浏览器重启后自动清空（兼顾隐私，不长期驻留论文内容）
//
// 存储失败一律静默降级（不影响主流程），因为缓存只是体验增强，不是关键路径。

import type { PaperContent } from '../extractors/types';
import type { SummaryResult } from '../../entrypoints/sidepanel/tabs/SummaryTab';
import type { DerivationResult } from '../../entrypoints/sidepanel/tabs/DerivationTab';

/** 单个页面（URL）对应的缓存内容 */
export interface PageCache {
  paper: PaperContent | null;
  summary: SummaryResult | null;
  derivations: Record<number, DerivationResult>;
  /** 写入时间戳，便于将来做过期清理 */
  savedAt: number;
}

const KEY_PREFIX = 'paperlens.cache:';
const TAB_DOCUMENT_PREFIX = 'paperlens.tab-document:';
const pendingWrites = new Map<string, Promise<boolean>>();

export interface TabDocumentBinding {
  /** 上传 PDF 的稳定缓存键。 */
  documentKey: string;
  /** 上传时所在浏览器标签页的 URL，用于导航后自动使绑定失效。 */
  sourceTabUrl: string;
  title: string;
}

/** 判断 chrome.storage.session 是否可用（老版本浏览器可能没有） */
function sessionAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.session;
}

/**
 * 页面缓存只忽略 URL hash：PDF 阅读器的页码变化不应创建新文档；
 * 查询参数可能是签名或文档身份的一部分，不能擅自删除。
 */
export function normalizePageCacheKey(url: string): string {
  if (!url || url.startsWith('pdf:')) return url;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return url;
  }
}

function keyFor(url: string): string {
  return KEY_PREFIX + normalizePageCacheKey(url);
}

function bindingKeyFor(tabId: number): string {
  return `${TAB_DOCUMENT_PREFIX}${tabId}`;
}

/** 读取某 URL 的缓存；不存在或异常时返回 null */
export async function loadPageCache(url: string): Promise<PageCache | null> {
  if (!url || !sessionAvailable()) return null;
  try {
    const k = keyFor(url);
    // 切页紧跟在状态更新之后时，必须先等同一文档的最新写入完成。
    await pendingWrites.get(k);
    const obj = await chrome.storage.session.get(k);
    return (obj?.[k] as PageCache | undefined) ?? null;
  } catch (err) {
    console.warn('[PaperLens] 读取会话缓存失败：', err);
    return null;
  }
}

/**
 * 写入某 URL 的缓存。同一文档严格串行，保证后到的 MinerU OCR 结果不会
 * 被较早发起、较晚完成的 Phase C 基线写回覆盖。
 */
export async function savePageCache(url: string, data: PageCache): Promise<boolean> {
  if (!url || !sessionAvailable()) return false;
  const k = keyFor(url);
  const previous = pendingWrites.get(k) ?? Promise.resolve(true);
  const current = previous
    .catch(() => false)
    .then(() => writePageCache(k, data));
  pendingWrites.set(k, current);
  try {
    return await current;
  } finally {
    if (pendingWrites.get(k) === current) pendingWrites.delete(k);
  }
}

/** 清除某 URL 的缓存；失败静默忽略 */
export async function clearPageCache(url: string): Promise<void> {
  if (!url || !sessionAvailable()) return;
  try {
    await chrome.storage.session.remove(keyFor(url));
  } catch (err) {
    console.warn('[PaperLens] 清除会话缓存失败：', err);
  }
}

/** 把上传 PDF 绑定到当前标签页，使切走再切回时仍能恢复其合成文档键。 */
export async function saveTabDocumentBinding(
  tabId: number,
  binding: TabDocumentBinding,
): Promise<boolean> {
  if (!Number.isInteger(tabId) || tabId < 0 || !sessionAvailable()) return false;
  try {
    await chrome.storage.session.set({
      [bindingKeyFor(tabId)]: {
        ...binding,
        sourceTabUrl: normalizePageCacheKey(binding.sourceTabUrl),
      },
    });
    return true;
  } catch (err) {
    console.warn('[PaperLens] 保存上传 PDF 标签页绑定失败：', err);
    return false;
  }
}

/**
 * 只在标签页仍停留于上传时的底层页面时恢复绑定；一旦发生真实导航便清除，
 * 避免把旧上传结果套到新页面。
 */
export async function loadTabDocumentBinding(
  tabId: number,
  sourceTabUrl: string,
): Promise<TabDocumentBinding | null> {
  if (!Number.isInteger(tabId) || tabId < 0 || !sessionAvailable()) return null;
  const k = bindingKeyFor(tabId);
  try {
    const obj = await chrome.storage.session.get(k);
    const binding = obj?.[k] as TabDocumentBinding | undefined;
    if (!binding) return null;
    if (binding.sourceTabUrl !== normalizePageCacheKey(sourceTabUrl)) {
      await chrome.storage.session.remove(k);
      return null;
    }
    return binding;
  } catch (err) {
    console.warn('[PaperLens] 读取上传 PDF 标签页绑定失败：', err);
    return null;
  }
}

async function writePageCache(key: string, data: PageCache): Promise<boolean> {
  try {
    await chrome.storage.session.set({ [key]: data });
    return true;
  } catch (firstError) {
    if (!isQuotaError(firstError)) {
      console.warn('[PaperLens] 写入会话缓存失败：', firstError);
      return false;
    }
  }

  await evictOldestPageCache(key);
  try {
    await chrome.storage.session.set({ [key]: data });
    return true;
  } catch (retryError) {
    console.warn('[PaperLens] 会话缓存容量不足，清理旧条目后仍写入失败：', retryError);
    return false;
  }
}

async function evictOldestPageCache(excludedKey: string): Promise<void> {
  try {
    const entries = await chrome.storage.session.get(null);
    const oldest = Object.entries(entries)
      .filter(([key]) => key.startsWith(KEY_PREFIX) && key !== excludedKey)
      .map(([key, value]) => ({
        key,
        savedAt: Number((value as PageCache | undefined)?.savedAt) || 0,
      }))
      .sort((left, right) => left.savedAt - right.savedAt)[0];
    if (oldest) await chrome.storage.session.remove(oldest.key);
  } catch (err) {
    console.warn('[PaperLens] 清理旧会话缓存失败：', err);
  }
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|QUOTA_BYTES/i.test(message);
}
