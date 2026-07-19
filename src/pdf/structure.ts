import type { Reference } from '../extractors/types';
import type { LayoutLine } from './textLayout';

/** 识别章节标题，覆盖阿拉伯/罗马/附录编号、常见词、字号与粗体特征。 */
export function detectHeading(line: LayoutLine, bodySize: number): { level: number } | null {
  const text = line.text.trim();
  if (!text || text.length >= 100) return null;

  const numbered = text.match(/^(\d+(?:\.\d+)*)\.?\s+([A-Za-z].{0,80})$/);
  if (numbered) return { level: Math.min(numbered[1].split('.').length, 4) };

  if (/^[IVXLCDM]+[.)]?\s+[A-Z].{0,80}$/.test(text)) return { level: 1 };
  if (/^[A-Z]\.\s+[A-Z].{0,80}$/.test(text)) return { level: 1 };

  if (
    text.length < 50 &&
    /^(abstract|introduction|related work|background|preliminaries|method(s|ology)?|approach|model|experiments?|evaluation|results?|analysis|discussion|conclusions?|limitations?|references|bibliography|acknowledge?ments?|appendix|参考文献)\b/i.test(
      text,
    )
  ) {
    return { level: 1 };
  }

  const looksLikeTitle = /^[A-Z]/.test(text) && !/[.;:,]$/.test(text);
  if (line.size > bodySize * 1.15 && text.length < 70 && looksLikeTitle) return { level: 1 };
  if (/bold|semibold|demi/i.test(line.font) && text.length < 70 && looksLikeTitle) {
    return { level: 1 };
  }
  return null;
}

/** 从标题下方的多行候选中提取作者，排除邮箱与常见机构行。 */
export function parseAuthorLines(lines: string[]): string[] {
  const authors: string[] = [];
  for (const raw of lines.slice(0, 8)) {
    const text = raw.trim();
    if (!text || /^abstract\b/i.test(text)) break;
    if (
      /@|https?:|\b(university|institute|department|school|college|laborator(?:y|ies)|research center|corporation|company|inc\.)\b/i.test(
        text,
      )
    ) {
      continue;
    }
    const names = text
      .split(/[¹²³⁴⁵⁶⁷⁸⁹∗*†‡]+|;|、|·|\s+and\s+|,(?=\s*[A-Z][A-Za-z'’-]+(?:\s|$))/i)
      .map((name) => name.replace(/^[\s\d,]+|[\s\d,]+$/g, '').trim())
      .filter((name) => {
        const words = name.split(/\s+/);
        return name.length >= 3 && name.length <= 70 && words.length >= 2 && words.length <= 6;
      });
    authors.push(...names);
  }
  return [...new Set(authors)];
}

/** 参考文献拆条：支持 [n]、n. 与作者-年份三类起始模式。 */
export function parseReferences(lines: string[]): Reference[] {
  const references: Reference[] = [];
  let buffer = '';

  const flush = () => {
    const text = buffer.replace(/\s+/g, ' ').trim();
    if (text) references.push({ index: references.length + 1, text });
    buffer = '';
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const numbered = line.match(/^\[(\d+)\]\s*/) ?? line.match(/^(\d{1,3})\.\s+/);
    const authorYear = /^[A-Z][A-Za-z'’ -]+,.*(?:\((?:19|20)\d{2}[a-z]?\)|,\s*(?:19|20)\d{2}[a-z]?\b)/.test(
      line,
    );
    if (numbered || (authorYear && buffer)) flush();

    const content = numbered
      ? line.replace(/^\[\d+\]\s*/, '').replace(/^\d{1,3}\.\s+/, '')
      : line;
    if (/-$/.test(buffer) && /^[a-z]/.test(content)) buffer = buffer.slice(0, -1) + content;
    else buffer += (buffer ? ' ' : '') + content;
  }
  flush();
  return references;
}
