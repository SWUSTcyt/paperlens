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

/** 判断 chrome.storage.session 是否可用（老版本浏览器可能没有） */
function sessionAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage?.session;
}

function keyFor(url: string): string {
  return KEY_PREFIX + url;
}

/** 读取某 URL 的缓存；不存在或异常时返回 null */
export async function loadPageCache(url: string): Promise<PageCache | null> {
  if (!url || !sessionAvailable()) return null;
  try {
    const k = keyFor(url);
    const obj = await chrome.storage.session.get(k);
    return (obj?.[k] as PageCache | undefined) ?? null;
  } catch (err) {
    console.warn('[PaperLens] 读取会话缓存失败：', err);
    return null;
  }
}

/** 写入某 URL 的缓存；失败静默忽略 */
export async function savePageCache(url: string, data: PageCache): Promise<void> {
  if (!url || !sessionAvailable()) return;
  try {
    await chrome.storage.session.set({ [keyFor(url)]: data });
  } catch (err) {
    console.warn('[PaperLens] 写入会话缓存失败：', err);
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
