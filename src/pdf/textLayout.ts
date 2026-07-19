/** PDF 文本层的纯版面重建逻辑；不依赖 pdf.js，便于用合成坐标做离线回归。 */

export interface RawItem {
  str: string;
  x: number;
  y: number;
  w: number;
  size: number;
  font: string;
}

export interface LayoutLine {
  page: number;
  pageWidth: number;
  pageHeight: number;
  /** 0=通栏/单栏，1=左栏，2=右栏 */
  column: 0 | 1 | 2;
  x: number;
  y: number;
  endX: number;
  size: number;
  font: string;
  text: string;
}

/** 重建单页阅读顺序；通栏块会把双栏正文切成上下阅读带。 */
export function buildPageLines(
  items: RawItem[],
  pageWidth: number,
  pageHeight: number,
  page: number,
): LayoutLine[] {
  if (!isTwoColumn(items, pageWidth)) {
    return groupIntoLines(items, page, pageWidth, pageHeight, 0);
  }

  const mid = pageWidth / 2;
  const gutter = pageWidth * 0.04;
  const spanning = items.filter(
    (item) => item.x < mid - gutter && item.x + item.w > mid + gutter,
  );
  const body = items.filter((item) => !spanning.includes(item));
  const left = groupIntoLines(
    body.filter((item) => item.x + item.w / 2 < mid),
    page,
    pageWidth,
    pageHeight,
    1,
  );
  const right = groupIntoLines(
    body.filter((item) => item.x + item.w / 2 >= mid),
    page,
    pageWidth,
    pageHeight,
    2,
  );
  const full = groupIntoLines(spanning, page, pageWidth, pageHeight, 0);

  if (full.length === 0) return [...left, ...right];

  const ordered: LayoutLine[] = [];
  let upper = Number.POSITIVE_INFINITY;
  for (const anchor of full) {
    appendColumnBand(ordered, left, right, upper, anchor.y);
    ordered.push(anchor);
    upper = anchor.y;
  }
  appendColumnBand(ordered, left, right, upper, Number.NEGATIVE_INFINITY);
  return ordered;
}

function appendColumnBand(
  target: LayoutLine[],
  left: LayoutLine[],
  right: LayoutLine[],
  upper: number,
  lower: number,
): void {
  target.push(
    ...left.filter((line) => line.y < upper && line.y > lower),
    ...right.filter((line) => line.y < upper && line.y > lower),
  );
}

function isTwoColumn(items: RawItem[], pageWidth: number): boolean {
  if (items.length < 8) return false;
  const mid = pageWidth / 2;
  const gutter = pageWidth * 0.04;
  let left = 0;
  let right = 0;
  let spanning = 0;
  for (const item of items) {
    if (item.x < mid - gutter && item.x + item.w > mid + gutter) spanning++;
    else if (item.x + item.w / 2 < mid) left++;
    else right++;
  }
  const bodyCount = left + right;
  return (
    left >= 3 &&
    right >= 3 &&
    left >= bodyCount * 0.25 &&
    right >= bodyCount * 0.25 &&
    spanning <= items.length * 0.25
  );
}

function groupIntoLines(
  items: RawItem[],
  page: number,
  pageWidth: number,
  pageHeight: number,
  column: LayoutLine['column'],
): LayoutLine[] {
  if (items.length === 0) return [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: RawItem[][] = [];
  let current: RawItem[] = [];
  let currentY = sorted[0].y;
  for (const item of sorted) {
    const tolerance = Math.max(2, item.size * 0.45);
    if (current.length > 0 && Math.abs(item.y - currentY) > tolerance) {
      groups.push(current);
      current = [];
    }
    if (current.length === 0) currentY = item.y;
    current.push(item);
  }
  if (current.length > 0) groups.push(current);
  return groups.map((group) => assembleLine(group, page, pageWidth, pageHeight, column));
}

function assembleLine(
  group: RawItem[],
  page: number,
  pageWidth: number,
  pageHeight: number,
  column: LayoutLine['column'],
): LayoutLine {
  group.sort((a, b) => a.x - b.x);
  let text = '';
  let previousEnd: number | null = null;
  for (const item of group) {
    if (previousEnd !== null && item.x - previousEnd > item.size * 0.25) text += ' ';
    text += item.str;
    previousEnd = item.x + item.w;
  }
  return {
    page,
    pageWidth,
    pageHeight,
    column,
    x: group[0].x,
    y: median(group.map((item) => item.y)),
    endX: Math.max(...group.map((item) => item.x + item.w)),
    size: median(group.map((item) => item.size)),
    font: mostCommon(group.map((item) => item.font)),
    text: text.replace(/\s+/g, ' ').trim(),
  };
}

/** 删除跨页重复的边缘短文本、页码和 arXiv 水印。 */
export function stripHeadersFooters(lines: LayoutLine[]): LayoutLine[] {
  const pages = new Set(lines.map((line) => line.page));
  const occurrences = new Map<string, Set<number>>();
  for (const line of lines) {
    if (!isEdgeLine(line) || line.text.length > 100) continue;
    const key = canonicalEdgeText(line.text);
    if (!key) continue;
    const found = occurrences.get(key) ?? new Set<number>();
    found.add(line.page);
    occurrences.set(key, found);
  }
  const repeatThreshold = Math.max(2, Math.ceil(pages.size * 0.5));

  return lines.filter((line) => {
    const text = line.text.trim();
    if (!text) return false;
    if (!isEdgeLine(line)) return true;
    if (/^\d{1,4}$/.test(text) || /^arxiv:\s*\d/i.test(text)) return false;
    const repeatedOn = occurrences.get(canonicalEdgeText(text))?.size ?? 0;
    return pages.size < 2 || repeatedOn < repeatThreshold;
  });
}

function isEdgeLine(line: LayoutLine): boolean {
  return line.y >= line.pageHeight * 0.88 || line.y <= line.pageHeight * 0.12;
}

function canonicalEdgeText(text: string): string {
  return text.trim().toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ');
}

/** 判断相邻行之间是否应断段。 */
export function shouldStartParagraph(
  previous: LayoutLine,
  current: LayoutLine,
  bodySize: number,
): boolean {
  if (previous.page === current.page && previous.column !== current.column) return true;
  if (previous.page !== current.page) return false;
  if (previous.y - current.y > bodySize * 1.65) return true;

  const indent = current.x - previous.x;
  const previousIsShort = previous.endX - previous.x < previous.pageWidth * 0.65;
  return (
    indent > bodySize * 1.5 &&
    previousIsShort &&
    /[.!?。！？:：]$/.test(previous.text) &&
    /^[A-Z\u4e00-\u9fff]/.test(current.text)
  );
}

/** 多行合并；仅在英文小写续行时去除行尾断词连字符。 */
export function joinLines(lines: string[]): string {
  let output = '';
  for (const raw of lines) {
    const text = raw.trim();
    if (!text) continue;
    if (!output) {
      output = text;
    } else if (/[A-Za-z]-$/.test(output) && /^[a-z]/.test(text)) {
      output = output.slice(0, -1) + text;
    } else {
      output += ` ${text}`;
    }
  }
  return output;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}
