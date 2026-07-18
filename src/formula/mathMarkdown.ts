// Markdown 中的数学公式预处理工具
// 思路：
//   1. 在 marked 解析之前，把 $$...$$ 与 $...$ 抠出来，替换为占位 span（data-pl-math="N"）
//   2. marked 正常解析 Markdown，DOMPurify 正常清洗（会保留占位 span）
//   3. 清洗后的 HTML 上把占位 span 替换为 KaTeX 渲染的 HTML
//
// 这样避开了 marked 默认对 $ 不特殊处理但容易被列表/强调语义"吃掉"的问题，
// 并且 KaTeX 的 HTML 是我们 trusted 的输出，不再需要二次 sanitize。

import katex from 'katex';

export interface MathItem {
  tex: string;
  display: boolean;
}

const BLOCK_RE = /\$\$([\s\S]+?)\$\$/g;
// 行内：限定在同一行内；避免误匹配文档里真正的 $（如货币符号）需要同时两侧出现
const INLINE_RE = /\$([^$\n]+?)\$/g;

/** 把 markdown 中的 $...$ / $$...$$ 抽出并替换为占位符 */
export function preprocessMath(md: string): { md: string; items: MathItem[] } {
  const items: MathItem[] = [];
  let out = md.replace(BLOCK_RE, (_m, tex) => {
    items.push({ tex: String(tex).trim(), display: true });
    // 用 HTML 块让 marked 视为原样 HTML
    return `\n\n<span data-pl-math="${items.length - 1}"></span>\n\n`;
  });
  out = out.replace(INLINE_RE, (_m, tex) => {
    items.push({ tex: String(tex).trim(), display: false });
    return `<span data-pl-math="${items.length - 1}"></span>`;
  });
  return { md: out, items };
}

/** 把 sanitize 后 HTML 里的占位符替换为 KaTeX HTML */
export function renderMathPlaceholders(html: string, items: MathItem[]): string {
  return html.replace(/<span data-pl-math="(\d+)"><\/span>/g, (_m, idx) => {
    const item = items[Number(idx)];
    if (!item) return '';
    try {
      // throwOnError: true —— 让非法公式抛错并走下方兜底，
      // 而不是渲染成 KaTeX 的红色报错块（对用户更友好）
      return katex.renderToString(item.tex, {
        displayMode: item.display,
        throwOnError: true,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      return `<code>${escapeHtml(item.tex)}</code>`;
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 直接把一段 LaTeX 渲染成 HTML（供公式列表展示） */
export function renderLatexToHtml(latex: string, display = false): string {
  try {
    // 同 renderMathPlaceholders：渲染失败回退为原样 <code>，避免展示红色报错块
    return katex.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      strict: 'ignore',
      output: 'html',
    });
  } catch {
    return `<code>${escapeHtml(latex)}</code>`;
  }
}
