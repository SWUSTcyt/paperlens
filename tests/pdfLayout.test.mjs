import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPageLines,
  joinLines,
  shouldStartParagraph,
  stripHeadersFooters,
} from '../src/pdf/textLayout.ts';

const item = (str, x, y, w = 80, size = 10) => ({ str, x, y, w, size, font: 'Body' });

test('混合双栏页保持跨栏标题、左栏、右栏的阅读顺序', () => {
  const lines = buildPageLines(
    [
      item('A Full Width Title', 50, 760, 500, 18),
      item('L1', 50, 700), item('L2', 50, 680), item('L3', 50, 660), item('L4', 50, 640),
      item('R1', 330, 700), item('R2', 330, 680), item('R3', 330, 660), item('R4', 330, 640),
    ],
    600,
    800,
    1,
  );
  assert.deepEqual(lines.map((line) => line.text), [
    'A Full Width Title', 'L1', 'L2', 'L3', 'L4', 'R1', 'R2', 'R3', 'R4',
  ]);
  assert.deepEqual(lines.map((line) => line.column), [0, 1, 1, 1, 1, 2, 2, 2, 2]);
});

test('重复页眉页脚按页面边缘删除，正文数字标题保留', () => {
  const page = (number) => [
    { ...line(`Conference 2026`, number, 780), pageHeight: 800 },
    { ...line('1', number, 500), pageHeight: 800 },
    { ...line(String(number), number, 20), pageHeight: 800 },
  ];
  const cleaned = stripHeadersFooters([...page(1), ...page(2), ...page(3)]);
  assert.deepEqual(cleaned.map((entry) => entry.text), ['1', '1', '1']);
});

test('跨栏切换会开始新段落', () => {
  const left = { ...line('left ending.', 1, 100), column: 1 };
  const right = { ...line('Right starts', 1, 700), column: 2 };
  assert.equal(shouldStartParagraph(left, right, 10), true);
});

test('joinLines 只对小写续行去除英文断词连字符', () => {
  assert.equal(joinLines(['inter-', 'national method']), 'international method');
  assert.equal(joinLines(['well-', 'Known method']), 'well- Known method');
});

function line(text, page, y) {
  return {
    page,
    pageWidth: 600,
    pageHeight: 800,
    column: 0,
    x: 50,
    y,
    endX: 180,
    size: 10,
    font: 'Body',
    text,
  };
}
