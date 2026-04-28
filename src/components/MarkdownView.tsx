import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { preprocessMath, renderMathPlaceholders } from '../formula/mathMarkdown';

// 轻量 Markdown + KaTeX 渲染组件
// 流程：
//   原始 MD → 抽离 $...$/$$...$$ 为占位 span → marked → DOMPurify → 把占位替换为 KaTeX HTML
// KaTeX 的输出是我们本地生成的 trusted HTML，因此在 sanitize 之后再拼回，避免被净化规则打掉。

marked.setOptions({
  gfm: true,
  breaks: true,
});

export function MarkdownView({ content, className }: { content: string; className?: string }) {
  const html = useMemo(() => {
    const { md, items } = preprocessMath(content ?? '');
    const raw = marked.parse(md, { async: false }) as string;
    const clean = DOMPurify.sanitize(raw, {
      ADD_ATTR: ['data-pl-math', 'target', 'rel'],
    });
    return renderMathPlaceholders(clean, items);
  }, [content]);

  return (
    <div
      className={
        'markdown-body text-sm leading-relaxed text-slate-800 dark:text-slate-200 ' +
        (className ?? '')
      }
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
