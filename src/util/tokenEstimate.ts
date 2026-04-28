// 轻量 token 估计（不引入 tiktoken 等重量库）
// 规则：
//   - 英文 / 符号：近似 4 字符 = 1 token
//   - 中日韩字符：近似 1.5 字符 = 1 token（比英文更稠密）
// 精度够用于"是否超长、是否要 Map-Reduce" 的分流

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // 基本 CJK、日文平片假名、韩文
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    } else {
      ascii++;
    }
  }
  return Math.ceil(ascii / 4 + cjk / 1.5);
}

export function truncateByTokens(text: string, maxTokens: number): string {
  if (!text) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  // 二分逼近一个合适长度
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '\n\n[…内容因长度限制被截断…]';
}
