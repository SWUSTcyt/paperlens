// 公式逐步推导 Prompt 模板
// 输出为 Markdown 五段式，行内/块级公式统一使用 $...$ / $$...$$

import type { Formula, PaperContent } from '../extractors/types';

const SYSTEM_PROMPT = `你是 PaperLens 的数学/公式教学助手。
目标是对用户选定的论文公式，给出"逐步推导 + 符号拆解 + 小例子"三位一体的教学解读。

硬性规则：
1. 仅基于用户给出的公式 LaTeX 与论文上下文作答。若需要引入常识性的外部前提（如微积分/线性代数基本性质），请用"[补充前提]"显式标注，不要伪造论文未写的假设。
2. 输出必须是 Markdown，严格按以下五个二级标题：
   ## 公式还原
   ## 符号与定义
   ## 逐步推导
   ## 关键运算解析
   ## 小例子
3. 所有公式保留 LaTeX：行内 $...$、块级 $$...$$。禁止用 Unicode 近似替代。
4. 「逐步推导」每一步给一行简短中文说明 + 一条块级公式，避免一步跨多个变换。
5. 「关键运算解析」针对难点/易错点（如爱因斯坦求和、梯度/期望/KL 散度）专门拆解。
6. 「小例子」给出具体数值，演示一轮完整计算，帮助读者"摸出数字"。
7. 若公式本身是定义式、不存在"推导"：把「逐步推导」改写为"如何从朴素形式过渡到本式"，并在末尾强调它是定义。`;

export function buildDerivationSystem(): string {
  return SYSTEM_PROMPT;
}

export interface BuildDerivationUserOptions {
  /** 可选：公式上下文文本（附近段落） */
  context?: string;
}

export function buildDerivationUser(
  paper: PaperContent,
  formula: Formula,
  opts: BuildDerivationUserOptions = {},
): string {
  const lines: string[] = [];
  lines.push('# 论文信息');
  if (paper.title) lines.push(`- 标题：${paper.title}`);
  if (paper.categories.length) lines.push(`- 分类：${paper.categories.join(', ')}`);
  lines.push('');
  lines.push('# 目标公式');
  lines.push(`- 编号：${formula.id}`);
  if (formula.sectionPath) lines.push(`- 位置：${formula.sectionPath}`);
  lines.push(`- 形式：${formula.display ? '块级' : '行内'}`);
  lines.push('');
  lines.push('```latex');
  lines.push(formula.latex);
  lines.push('```');
  if (opts.context && opts.context.trim()) {
    lines.push('');
    lines.push('# 上下文（公式所在章节附近的正文）');
    lines.push(opts.context.trim());
  }
  lines.push('');
  lines.push('# 任务');
  lines.push(
    '请严格按 System 指示的五段式 Markdown 输出推导。确保读者即使没看原文，也能从你的讲解独立把公式理解+复现一遍。',
  );
  return lines.join('\n');
}
