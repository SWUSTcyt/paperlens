import assert from 'node:assert/strict';
import test from 'node:test';

import { detectHeading, parseAuthorLines, parseReferences } from '../src/pdf/structure.ts';

test('detectHeading 识别罗马编号、附录编号和同字号粗体标题', () => {
  assert.deepEqual(detectHeading(line('II. RELATED WORK'), 10), { level: 1 });
  assert.deepEqual(detectHeading(line('A. Additional Results'), 10), { level: 1 });
  assert.deepEqual(detectHeading(line('Ablation Study', 'BoldFont'), 10), { level: 1 });
  assert.equal(detectHeading(line('This is ordinary body text.'), 10), null);
});

test('parseAuthorLines 合并多行作者并排除机构与邮箱', () => {
  assert.deepEqual(
    parseAuthorLines([
      'Alice Smith, Bob Jones',
      'Carol Wu',
      'Example University, alice@example.org',
    ]),
    ['Alice Smith', 'Bob Jones', 'Carol Wu'],
  );
});

test('parseAuthorLines 用 PDF 脚注符拆分同一视觉行中的多位作者', () => {
  assert.deepEqual(
    parseAuthorLines([
      'Ashish Vaswani∗ Noam Shazeer∗ Niki Parmar∗ Jakob Uszkoreit∗',
      'Google Brain Google Brain Google Research Google Research',
      'avaswani@google.com noam@google.com nikip@google.com usz@google.com',
      'Llion Jones∗ Aidan N. Gomez∗ † Łukasz Kaiser∗',
      'Illia Polosukhin∗ ‡',
    ]),
    [
      'Ashish Vaswani',
      'Noam Shazeer',
      'Niki Parmar',
      'Jakob Uszkoreit',
      'Llion Jones',
      'Aidan N. Gomez',
      'Łukasz Kaiser',
      'Illia Polosukhin',
    ],
  );
});

test('parseReferences 支持编号条目和作者-年份条目', () => {
  assert.deepEqual(
    parseReferences(['[1] First paper.', 'continued.', '[2] Second paper.']).map((ref) => ref.text),
    ['First paper. continued.', 'Second paper.'],
  );
  assert.deepEqual(
    parseReferences([
      'Smith, J. (2020). First paper.',
      'Journal details.',
      'Wu, C. and Jones, B. (2021). Second paper.',
    ]).map((ref) => ref.text),
    [
      'Smith, J. (2020). First paper. Journal details.',
      'Wu, C. and Jones, B. (2021). Second paper.',
    ],
  );
});

function line(text, font = 'Body') {
  return {
    page: 1,
    pageWidth: 600,
    pageHeight: 800,
    column: 0,
    x: 50,
    y: 500,
    endX: 300,
    size: 10,
    font,
    text,
  };
}
