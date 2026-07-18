// 论文解读流水线：
// - 短论文：单次请求直接解读
// - 长论文：先逐章节做"精简摘要"（Map），再对所有精简结果做"最终汇总"（Reduce）
//
// 流水线以 AsyncGenerator<ChatStreamChunk> 的形式对外暴露进度：
//   - Map 阶段的中间产物不向外流，只在内部累积
//   - Reduce 阶段（即最终解读）流式 yield 给 UI

import type { PaperContent } from '../extractors/types';
import {
  buildSummarySystem,
  buildSummaryUser,
  flattenSectionsToText,
  type Verbosity,
} from '../prompts/summary';
import { chatStream, chatOnce, type ChatStreamChunk } from '../bridge/llmBridge';
import { estimateTokens, truncateByTokens } from '../util/tokenEstimate';

/** 触发 Map-Reduce 的 token 阈值；超过后按章节拆分 */
const MAP_REDUCE_THRESHOLD = 8000;
/** Map 阶段：每章节压缩到的目标 token 数（约） */
const MAP_TARGET_TOKENS = 500;
/** Reduce 阶段：送入最终 prompt 的整体 token 预算 */
const REDUCE_BUDGET_TOKENS = 6000;
/**
 * prompt 固定开销预留（system 提示词 + 元信息 + 输出格式说明约占的 token）。
 * estimateTokens 是轻量启发式、偏乐观，这里预留余量避免真实 token 超出小上下文模型。
 */
const PROMPT_OVERHEAD_TOKENS = 600;
/** Map 阶段：单章节送入模型的输入 token 上限（原为硬编码 3000，过小会丢长章节内容） */
const PER_SECTION_INPUT_TOKENS = 4500;
/** Map 阶段：单章节输出的 token 上限（略高于目标，留一点头部空间） */
const MAP_OUTPUT_MAX_TOKENS = MAP_TARGET_TOKENS + 200;

export interface SummarizeOptions {
  verbosity: Verbosity;
  signal?: AbortSignal;
}

export interface SummarizeProgress {
  /** 当前阶段描述，便于 UI 展示 */
  phase: 'prepare' | 'mapping' | 'reducing' | 'done';
  /** Map 阶段用，[当前, 总共] */
  mapProgress?: { current: number; total: number };
}

export interface SummarizeChunk extends ChatStreamChunk {
  progress?: SummarizeProgress;
}

/**
 * 对论文生成解读，流式返回。
 * yield 的 chunk：
 *   - progress 字段：阶段进度（UI 可据此显示"正在精简第 X/Y 节…"）
 *   - 其他字段：chatStream 的 delta（content/reasoning/error）
 */
export async function* summarizePaper(
  paper: PaperContent,
  opts: SummarizeOptions,
): AsyncGenerator<SummarizeChunk, void, void> {
  yield { type: 'delta', progress: { phase: 'prepare' } };

  const body = flattenSectionsToText(paper.sections);
  const bodyTokens = estimateTokens(body);

  let bodyForPrompt: string;

  if (bodyTokens <= MAP_REDUCE_THRESHOLD || paper.sections.length === 0) {
    // 短论文或 abs 页（无章节）：单次请求即可（预留 prompt 固定开销，避免超上下文）
    bodyForPrompt = truncateByTokens(body, MAP_REDUCE_THRESHOLD - PROMPT_OVERHEAD_TOKENS);
  } else {
    // 长论文：Map 阶段 —— 对每个顶层章节做精简
    const topSections = paper.sections;
    const mapResults: string[] = [];
    for (let i = 0; i < topSections.length; i++) {
      if (opts.signal?.aborted) return;
      yield {
        type: 'delta',
        progress: { phase: 'mapping', mapProgress: { current: i + 1, total: topSections.length } },
      };

      const sec = topSections[i];
      const sectionText = flattenSectionsToText([sec]);
      const truncated = truncateByTokens(sectionText, PER_SECTION_INPUT_TOKENS); // 单章节输入上限
      const { content } = await chatOnce({
        task: 'summary',
        signal: opts.signal,
        // 约束单章节压缩的输出长度，避免个别章节输出过长拖慢/超预算
        overrides: { maxTokens: MAP_OUTPUT_MAX_TOKENS },
        messages: [
          {
            role: 'system',
            content:
              '你是论文长文压缩助手。对用户给出的论文章节原文，输出 ' +
              MAP_TARGET_TOKENS +
              ' token 以内的中文要点摘要，保留关键公式（LaTeX $...$）、数字指标与术语，禁止杜撰。',
          },
          {
            role: 'user',
            content: `章节标题：${sec.heading || '(无标题)'}\n\n原文：\n${truncated}`,
          },
        ],
      });
      mapResults.push(`## ${sec.heading || `章节 ${i + 1}`}\n${content.trim()}`);
    }

    // 合并 Map 结果，保证不超 Reduce 预算（同样预留 prompt 固定开销）
    bodyForPrompt = truncateByTokens(
      mapResults.join('\n\n'),
      REDUCE_BUDGET_TOKENS - PROMPT_OVERHEAD_TOKENS,
    );
  }

  if (opts.signal?.aborted) return;
  yield { type: 'delta', progress: { phase: 'reducing' } };

  const system = buildSummarySystem();
  const user = buildSummaryUser(paper, {
    verbosity: opts.verbosity,
    bodyText: bodyForPrompt,
  });

  for await (const chunk of chatStream({
    task: 'summary',
    signal: opts.signal,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })) {
    yield chunk;
  }

  yield { type: 'delta', progress: { phase: 'done' } };
}
