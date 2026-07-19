// 从 DOM 里的 MathML / LaTeXML 节点抽取 LaTeX 源。
// 设计原则：优先依赖 `<math alttext="...">` 中的 alttext（LaTeXML/ar5iv 输出）——这是最可靠的 LaTeX 源；
// 无 alttext 时退化为 MathML 内的 <annotation encoding="application/x-tex">；
// 再无则返回 MathML 文本，供 LLM 自己理解。

export interface RawFormula {
  latex: string;
  display: boolean;
  anchor?: string;
}

/**
 * 从单个 <math> 节点抽取 LaTeX 源。
 * 返回 null 表示抽不出有效 LaTeX（调用方自行决定是否跳过）。
 */
export function extractLatexFromMathNode(node: Element): RawFormula | null {
  if (node.tagName.toLowerCase() !== 'math') return null;

  // display 判定：优先看 <math display="block">；
  // 但 ar5iv/LaTeXML 常把 display 方程里的 <math> 也标成 display="inline"，
  // 因此再根据祖先容器（方程块 / 方程组 / 公式表）推断，避免 display 公式被误判为行内。
  const display =
    node.getAttribute('display') === 'block' ||
    !!node.closest?.(
      '.ltx_equation, .ltx_equationgroup, .ltx_eqn_table, .ltx_eqnarray, .ltx_displaymath',
    );
  const anchor = node.id || node.closest('[id]')?.id || undefined;

  // 1. alttext（LaTeXML / ar5iv 都会输出，内容就是 LaTeX）
  const alt = node.getAttribute('alttext');
  if (alt && alt.trim()) {
    return { latex: normalizeLatex(alt), display, anchor };
  }

  // 2. <annotation encoding="application/x-tex">
  const anno = node.querySelector(
    'annotation[encoding="application/x-tex"], annotation[encoding="TeX"]',
  );
  if (anno?.textContent?.trim()) {
    return { latex: normalizeLatex(anno.textContent), display, anchor };
  }

  // 3. 兜底：返回可读文本（不是严格 LaTeX，但对 LLM 推理仍有价值）
  const text = node.textContent?.trim();
  if (text) {
    return { latex: text, display, anchor };
  }

  return null;
}

/**
 * 抽取一个容器内所有公式，并返回「段落 HTML → 占位符」映射，
 * 便于 extractor 用 `$1$`、`$$1$$` 这样的占位符拼接章节段落文本。
 */
export function collectFormulas(root: ParentNode): RawFormula[] {
  const nodes = Array.from(root.querySelectorAll('math')) as Element[];
  const out: RawFormula[] = [];
  for (const n of nodes) {
    const f = extractLatexFromMathNode(n);
    if (f) out.push(f);
  }
  return out;
}

/**
 * 将一段 DOM 节点转成"带公式占位符的纯文本"。
 * - 遇到 <math> 节点，用其 LaTeX 源替换为 `$...$` 或 `$$...$$`
 * - 其他节点递归取 textContent
 *
 * 同时返回这段文本里引用到的公式索引（从外部 formulas 数组的位置）。
 */
export function renderTextWithFormulas(
  root: Node,
  /** 当遇到 <math> 节点时回调，返回对应公式在全局列表里的 1-based id */
  onMath: (raw: RawFormula) => number,
): string {
  const out: string[] = [];

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent ?? '';
      if (t) out.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === 'math') {
      const f = extractLatexFromMathNode(el);
      if (f) {
        const id = onMath(f);
        // 在原始 DOM 节点上打标，便于 SidePanel 点"回跳原文"时精确滚动
        try {
          (el as HTMLElement).setAttribute('data-pl-fid', String(id));
        } catch {
          // 理论上不会失败，忽略
        }
        out.push(f.display ? `\n$$${f.latex}$$\n` : `$${f.latex}$`);
      }
      return;
    }

    // 一些 ar5iv/LaTeXML 元素是跳过不会损失信息的（如 label、tag、margin note）
    if (
      el.classList.contains('ltx_tag') ||
      el.classList.contains('ltx_note_outer') ||
      el.classList.contains('ltx_role_footnote') ||
      tag === 'script' ||
      tag === 'style'
    ) {
      return;
    }

    // 段落/块级元素追加换行，保证可读性
    const isBlock =
      tag === 'p' ||
      tag === 'div' ||
      tag === 'br' ||
      tag === 'li' ||
      tag === 'tr';

    for (const child of Array.from(el.childNodes)) {
      walk(child);
    }
    if (isBlock) out.push('\n');
  }

  walk(root);
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 粗粒度清理 LaTeX 源：去掉 ar5iv 专有宏、统一空白 */
function normalizeLatex(src: string): string {
  return src
    .replace(/\s+/g, ' ')
    .replace(/\\displaystyle\s+/g, '')
    .replace(/\\textstyle\s+/g, '')
    .replace(/\\mathop\{([^}]*)\}/g, '$1')
    .trim();
}
