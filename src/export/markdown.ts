// PaperLens Markdown 导出模板
// 把论文元信息 + 解读 + 推导汇聚成一份可读、对 GitHub / Obsidian / Typora 友好的 .md 文件

import type { Formula, PaperContent } from '../extractors/types';
import type { SummaryResult } from '../../entrypoints/sidepanel/tabs/SummaryTab';
import type { DerivationResult } from '../../entrypoints/sidepanel/tabs/DerivationTab';

const EXT_VERSION = '0.0.1';

export interface BuildMarkdownInput {
  paper: PaperContent;
  summary: SummaryResult | null;
  derivations: Record<number, DerivationResult>;
}

export function buildMarkdown({ paper, summary, derivations }: BuildMarkdownInput): string {
  const lines: string[] = [];
  const now = new Date();

  // 头部元信息（YAML front-matter，方便导入笔记软件）
  lines.push('---');
  lines.push(`title: ${escYaml(paper.title || '(untitled)')}`);
  if (paper.authors.length) lines.push(`authors: [${paper.authors.map(escYaml).join(', ')}]`);
  if (paper.arxivId) lines.push(`arxiv_id: ${paper.arxivId}`);
  if (paper.categories.length) lines.push(`categories: [${paper.categories.map(escYaml).join(', ')}]`);
  lines.push(`source_url: ${paper.url}`);
  lines.push(`extracted_at: ${new Date(paper.extractedAt).toISOString()}`);
  lines.push(`generated_at: ${now.toISOString()}`);
  lines.push(`generator: PaperLens v${EXT_VERSION}`);
  lines.push('---');
  lines.push('');

  // 标题 + 元信息可读段
  lines.push(`# ${paper.title || '(untitled)'}`);
  lines.push('');
  if (paper.authors.length) lines.push(`**作者**：${paper.authors.join(', ')}`);
  if (paper.categories.length) lines.push(`**分类**：${paper.categories.join(', ')}`);
  if (paper.arxivId) lines.push(`**arXiv**：[${paper.arxivId}](https://arxiv.org/abs/${paper.arxivId})`);
  lines.push(`**来源**：[${paper.url}](${paper.url})`);
  lines.push('');

  // 摘要（原文）
  if (paper.abstract) {
    lines.push('## 原文摘要');
    lines.push('');
    lines.push(paper.abstract);
    lines.push('');
  }

  // 解读
  lines.push('## 论文解读');
  lines.push('');
  if (summary?.content) {
    const providerLine = providerLabel(summary.providerId, summary.model);
    if (providerLine) lines.push(`> 由 ${providerLine} 生成`);
    lines.push('');
    lines.push(summary.content.trim());
  } else {
    lines.push('> 尚未生成解读（请先在「论文解读」标签页点「生成解读」）。');
  }
  lines.push('');

  // 公式推导
  lines.push('## 公式推导');
  lines.push('');
  const heuristicFormulas = paper.formulaSupport === 'heuristic';
  if (heuristicFormulas) {
    lines.push('> **AI 识别，实验性**：公式来自 PDF 文本层，可能缺符号、错位或误识别；请对照原 PDF。');
    lines.push('');
  }
  const doneFormulas = paper.formulas.filter((f) => derivations[f.id]?.content);
  if (doneFormulas.length === 0) {
    lines.push('> 尚未生成任何公式推导（请先在「公式推导」标签页选择公式并点「生成推导」）。');
    lines.push('');
  } else {
    lines.push(`本次共 **${doneFormulas.length}** / ${paper.formulas.length} 个公式有推导结果。`);
    lines.push('');
    for (const f of doneFormulas) {
      lines.push(`### 公式 #${f.id}${f.sectionPath ? `（章节：${f.sectionPath}）` : ''}`);
      lines.push('');
      lines.push(formulaBlock(f, heuristicFormulas));
      const d = derivations[f.id]!;
      const providerLine = providerLabel(d.providerId, d.model);
      if (providerLine) {
        lines.push(`> 由 ${providerLine} 生成`);
        lines.push('');
      }
      lines.push(d.content.trim());
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // 附录：全部公式清单（即使未推导也收录，方便回顾）
  if (paper.formulas.length > 0) {
    lines.push('## 附录：公式清单');
    lines.push('');
    for (const f of paper.formulas) {
      const has = !!derivations[f.id]?.content;
      lines.push(
        `- **#${f.id}** ${f.sectionPath ? `_${f.sectionPath}_ ` : ''}${has ? '（已推导）' : ''}`,
      );
      lines.push('');
      lines.push(formulaBlock(f, heuristicFormulas));
      lines.push('');
    }
  }

  lines.push('');
  lines.push(`<sub>由 PaperLens v${EXT_VERSION} 于 ${now.toLocaleString()} 自动生成。</sub>`);
  lines.push('');

  return lines.join('\n');
}

function formulaBlock(f: Formula, heuristic: boolean): string {
  if (heuristic) {
    const location = [f.page ? `第 ${f.page} 页` : '', f.confidence != null ? `置信度 ${Math.round(f.confidence * 100)}%` : '']
      .filter(Boolean)
      .join(' · ');
    const lines: string[] = [];
    if (location) lines.push(`> ${location}`, '');
    lines.push('```text', f.latex, '```');
    return lines.join('\n');
  }
  // 网页来源有真实 LaTeX，统一用块级展示。
  return ['$$', f.latex, '$$'].join('\n');
}

function providerLabel(providerId?: string, model?: string): string {
  if (!providerId && !model) return '';
  if (providerId && model) return `${providerId} / ${model}`;
  return providerId || model || '';
}

function escYaml(s: string): string {
  // YAML 字符串：若含特殊字符用双引号包裹并转义
  if (/[:\-{}\[\],&*#?|<>=!%@`"'\n]/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

/** 推荐文件名 */
export function suggestFilename(paper: PaperContent): string {
  const date = formatDate(new Date());
  const slugSource = paper.arxivId || slugify(paper.title) || 'paper';
  return `paperlens-${slugSource}-${date}.md`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
