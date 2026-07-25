import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/release-extension.yml', import.meta.url);

async function readWorkflow() {
  return readFile(workflowPath, 'utf8');
}

test('扩展发布仅由 paperlens-v* tag 触发，并授予 Release 写权限', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /push:\s*\n\s*tags:\s*\n\s*-\s*['"]paperlens-v\*['"]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*write/);
  assert.doesNotMatch(workflow, /mineru-v/);
  assert.doesNotMatch(workflow, /workflow_dispatch/);
});

test('发布前校验 tag 与 package.json 版本，并完成编译、构建和打包', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /pnpm\/action-setup@v4\.4\.0/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /version:\s*10\.33\.2/);
  assert.match(workflow, /GITHUB_REF_NAME#paperlens-v/);
  assert.match(workflow, /require\(['"]\.\/package\.json['"]\)\.version/);
  assert.match(workflow, /TAG_VERSION.*PACKAGE_VERSION|PACKAGE_VERSION.*TAG_VERSION/s);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm compile/);
  assert.match(workflow, /pnpm build/);
  assert.match(workflow, /pnpm zip/);
});

test('生成固定命名 ZIP 与 SHA-256，并拒绝覆盖已有 Release', async () => {
  const workflow = await readWorkflow();

  assert.match(workflow, /paperlens-\$\{\{ steps\.version\.outputs\.version \}\}-chrome\.zip/);
  assert.match(workflow, /sha256sum/);
  assert.match(workflow, /gh release view/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /--verify-tag/);
  assert.doesNotMatch(workflow, /--clobber|--draft|--prerelease/);
  assert.match(workflow, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/);
});
