// 论文解读 Prompt 模板
// 输出格式固定为 Markdown，五段式结构，便于流式渲染与后续 Markdown 导出

import type { PaperContent, Section } from '../extractors/types';

export type Verbosity = 'concise' | 'detailed';

const SYSTEM_PROMPT = `你是 PaperLens 内置的论文解读助手。你的职责是为研究人员/工程师生成严谨、结构化的中文论文解读。

请遵守以下硬性规则：
1. 仅基于用户提供的论文正文内容作答，禁止编造作者或论文中未出现的事实；若正文中信息不足以回答某一点，用"原文未给出"明确标注，不要猜测。
2. 输出必须是 Markdown，且按以下固定的五个二级标题展开：
   ## 研究问题
   ## 方法
   ## 主要贡献
   ## 实验与结果
   ## 结论
3. 每个二级标题下使用段落或 Markdown 列表。避免口语化套话（如"本文非常棒"）。
4. 出现数学公式时保留 LaTeX 语法（行内公式用 $...$，块级公式用 $$...$$），不要用 Unicode 近似替代。
5. 术语首次出现时可中英文对照，例如："对比学习 (Contrastive Learning)"。`;

export function buildSummarySystem(): string {
  return SYSTEM_PROMPT;
}

interface BuildUserOptions {
  verbosity: Verbosity;
  /** 正文按 token 预算截断后的文本 */
  bodyText: string;
}

/**
 * 构造一次性解读的 user prompt
 */
export function buildSummaryUser(paper: PaperContent, opts: BuildUserOptions): string {
  const lines: string[] = [];
  lines.push(`# 论文元信息`);
  lines.push(`- 标题：${paper.title || '(未知)'}`);
  if (paper.authors.length) lines.push(`- 作者：${paper.authors.join(', ')}`);
  if (paper.categories.length) lines.push(`- 分类：${paper.categories.join(', ')}`);
  if (paper.arxivId) lines.push(`- arXiv ID：${paper.arxivId}`);

  if (paper.abstract) {
    lines.push('');
    lines.push('# 摘要');
    lines.push(paper.abstract);
  }

  lines.push('');
  lines.push('# 正文（可能已按长度限制截断）');
  lines.push(opts.bodyText || '(无可用正文，请仅基于摘要作答)');

  lines.push('');
  lines.push('# 任务');
  if (opts.verbosity === 'detailed') {
    lines.push(
      '请按 System 指示的五段式 Markdown 结构输出详细解读。每段 3~6 句或 3~8 个要点；对关键公式、数据指标要引用原文写法；确保下游读者可以在不看原文的情况下理解论文核心贡献。',
    );
  } else {
    lines.push(
      '请按 System 指示的五段式 Markdown 结构输出简洁解读。每段 2~4 句或 2~5 个要点；优先聚焦研究动机、方法要点、主要数字结果。',
    );
  }
  return lines.join('\n');
}

/** 把章节树拍平成一段带标题的长文本，保留层级以便 LLM 理解 */
export function flattenSectionsToText(sections: Section[]): string {
  const out: string[] = [];

  function walk(s: Section) {
    const prefix = '#'.repeat(Math.min(s.level + 1, 6));
    if (s.heading) out.push(`${prefix} ${s.heading}`);
    for (const p of s.paragraphs) {
      if (p.trim()) out.push(p.trim());
    }
    for (const c of s.children) walk(c);
  }

  for (const s of sections) walk(s);
  return out.join('\n\n');
}
