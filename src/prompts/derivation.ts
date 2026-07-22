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

const PDF_HEURISTIC_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

PDF 实验性公式规则：
1. 用户提供的是 PDF 文本层中的疑似公式原文，不是真实 LaTeX；必须先还原为最可能的规范 LaTeX，再开始解释和推导。
2. 在「公式还原」中同时列出原始文本和还原后的 LaTeX，并说明编号、断字或乱码是如何处理的。
3. 若存在歧义或信息缺失，必须显式写出不确定点和采用的保守解释；不得把猜测描述成论文原式。
4. 行尾形如 (3) 的内容通常是公式编号，不应还原成公式的一部分。
5. 后续四节只基于已经声明的还原结果推导；无法可靠还原时应停止推导，并建议用户对照原 PDF。`;

const MINERU_OCR_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

MinerU OCR 公式规则：
1. 用户提供的是 MinerU 从 PDF 图像识别出的 LaTeX，不是作者 TeX 源码；它可能漏检、错符号或截断。
2. 不得凭论文标题、经典公式记忆或外部知识静默替换输入，也不得把记忆中的标准公式冒充本次 OCR 证据。
3. 在“公式还原”中先逐字复述收到的 OCR LaTeX，再列出语法或语义上可疑的位置；修正建议必须显式标为“建议”，并保留不确定性。
4. 用户可在界面中查看 page+bbox 裁剪图，但模型看不到该图片；不得声称已经核对图片。
5. 若 OCR 明显截断或信息不足，应停止后续推导并请用户对照裁剪图，不要用模型记忆补齐。`;

export function buildDerivationSystem(): string {
  return SYSTEM_PROMPT;
}

export interface BuildDerivationUserOptions {
  /** 可选：公式上下文文本（附近段落） */
  context?: string;
}

export interface BuiltDerivationPrompt {
  system: string;
  user: string;
  heuristic: boolean;
  ocr: boolean;
}

/** 按公式来源选择 prompt；网页真 LaTeX 继续走原模板。 */
export function buildDerivationPrompt(
  paper: PaperContent,
  formula: Formula,
  opts: BuildDerivationUserOptions = {},
): BuiltDerivationPrompt {
  if (paper.formulaSupport === 'heuristic') {
    return {
      system: PDF_HEURISTIC_SYSTEM_PROMPT,
      user: buildPdfHeuristicDerivationUser(paper, formula, opts),
      heuristic: true,
      ocr: false,
    };
  }
  if (paper.formulaSupport === 'ocr' || formula.recognitionSource === 'mineru-ocr') {
    return {
      system: MINERU_OCR_SYSTEM_PROMPT,
      user: buildMineruOcrDerivationUser(paper, formula, opts),
      heuristic: false,
      ocr: true,
    };
  }
  return {
    system: buildDerivationSystem(),
    user: buildDerivationUser(paper, formula, opts),
    heuristic: false,
    ocr: false,
  };
}

function buildMineruOcrDerivationUser(
  paper: PaperContent,
  formula: Formula,
  opts: BuildDerivationUserOptions,
): string {
  const lines: string[] = [];
  lines.push('# 论文信息');
  if (paper.title) lines.push(`- 标题：${paper.title}`);
  if (paper.categories.length) lines.push(`- 分类：${paper.categories.join(', ')}`);
  lines.push('');
  lines.push('# MinerU OCR 候选');
  lines.push(`- 编号：${formula.id}`);
  if (formula.sectionPath) lines.push(`- 章节：${formula.sectionPath}`);
  if (formula.page) lines.push(`- 页码：第 ${formula.page} 页`);
  if (formula.bbox) lines.push(`- bbox（0–1000）：${formula.bbox.join(', ')}`);
  lines.push('- 来源：MinerU 3.4.4 pipeline；不是作者 TeX 源码');
  lines.push('');
  lines.push('```latex');
  lines.push(formula.latex);
  lines.push('```');
  if (opts.context?.trim()) {
    lines.push('');
    lines.push('# 邻近正文（来自 PDF 结构解析）');
    lines.push(opts.context.trim());
  }
  lines.push('');
  lines.push('# 任务');
  lines.push('严格按 System 指示审查这份 OCR LaTeX。不要调用对经典论文的记忆来静默补齐；发现截断或歧义时停止推导并提示对照裁剪图。');
  return lines.join('\n');
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

function buildPdfHeuristicDerivationUser(
  paper: PaperContent,
  formula: Formula,
  opts: BuildDerivationUserOptions,
): string {
  const lines: string[] = [];
  lines.push('# 论文信息');
  if (paper.title) lines.push(`- 标题：${paper.title}`);
  if (paper.categories.length) lines.push(`- 分类：${paper.categories.join(', ')}`);
  lines.push('');
  lines.push('# 疑似公式位置');
  lines.push(`- 编号：${formula.id}`);
  if (formula.sectionPath) lines.push(`- 章节：${formula.sectionPath}`);
  if (formula.page) lines.push(`- 页码：第 ${formula.page} 页`);
  if (formula.confidence != null) {
    lines.push(`- 启发式置信度：${Math.round(formula.confidence * 100)}%`);
  }
  lines.push(`- 形式：${formula.display ? '疑似块级' : '疑似行内'}`);
  lines.push('');
  lines.push('# 原始 PDF 公式文本');
  lines.push('```text');
  lines.push(formula.latex);
  lines.push('```');
  if (opts.context && opts.context.trim()) {
    lines.push('');
    lines.push('# 上下文（疑似公式附近的正文）');
    lines.push(opts.context.trim());
  }
  lines.push('');
  lines.push('# 任务');
  lines.push(
    '先审查原始文本并还原最可能的 LaTeX，再严格按 System 指示的五段式 Markdown 输出。若无法可靠还原，请明确停止，不要编造推导。',
  );
  return lines.join('\n');
}
