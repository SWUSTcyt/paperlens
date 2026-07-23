import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, openSync } from 'node:fs';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  process.env.PAPERLENS_CHROME,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const INTERACTIVE_PERMISSIONS = process.argv.includes('--interactive-permissions');
const PHASE_C = process.argv.includes('--phase-c');
const MINERU = process.argv.includes('--mineru');
const OFFLINE = process.argv.includes('--offline');
const UNSANDBOXED_BROWSER = process.env.PAPERLENS_CHROME_NO_SANDBOX === '1';

async function main() {
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

if (!chromePath) throw new Error('未找到 Chrome/Edge；可通过 PAPERLENS_CHROME 指定路径。');

const workspace = path.resolve(import.meta.dirname, '..');
const mineruPort = Number.parseInt(process.env.PAPERLENS_MINERU_PORT || '17860', 10);
const mineruToken = process.env.PAPERLENS_MINERU_TOKEN || '';
if (MINERU) {
  if (!Number.isInteger(mineruPort) || mineruPort < 1 || mineruPort > 65535 || !mineruToken) {
    throw new Error('--mineru 需要有效的 PAPERLENS_MINERU_PORT 与 PAPERLENS_MINERU_TOKEN。');
  }
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${mineruPort}/v1/health`);
      const health = response.ok ? await response.json() : null;
      return health?.status === 'ready' && health?.engine?.version === '3.4.4';
    } catch {
      return false;
    }
  }, 30_000, '本地 MinerU 服务就绪');
}
const buildDir = path.join(workspace, '.output', 'chrome-mv3');
const runDir = await mkdtemp(path.join(tmpdir(), 'paperlens-phase-b-'));
const extensionDir = path.join(runDir, 'extension');
const profileDir = path.join(runDir, 'profile');
const chromeLog = path.join(runDir, 'chrome.log');
const fixturePath = path.join(runDir, 'attention-is-all-you-need.pdf');
const singleColumnFixturePath = path.join(runDir, 'adam.pdf');
const port = await getFreePort();

await cp(buildDir, extensionDir, { recursive: true });
const extensionId = await addTemporaryManifestKey(extensionDir);
await prepareFixture(process.env.PAPERLENS_ATTENTION_PDF, 'https://arxiv.org/pdf/1706.03762', fixturePath);
await prepareFixture(process.env.PAPERLENS_ADAM_PDF, 'https://arxiv.org/pdf/1412.6980', singleColumnFixturePath);
const fixtureServer = await startPdfServer(fixturePath);

const logHandle = openSync(chromeLog, 'a');
const chrome = spawn(
  chromePath,
  [
    '--disable-gpu',
    ...(UNSANDBOXED_BROWSER ? ['--disable-gpu-sandbox', '--no-sandbox'] : []),
    '--no-first-run',
    '--no-default-browser-check',
    INTERACTIVE_PERMISSIONS ? '--window-position=100,100' : '--window-position=-32000,-32000',
    '--window-size=1200,900',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    'about:blank',
  ],
  { detached: false, stdio: ['ignore', logHandle, logHandle], windowsHide: true },
);

const results = [];
let browserClient;
let sidepanelClient;

try {
  const version = await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }, 20_000, 'Chrome DevTools 启动');
  browserClient = await CdpClient.connect(version.webSocketDebuggerUrl);

  const sidepanel = await newTarget(port, `chrome-extension://${extensionId}/sidepanel.html`);
  sidepanelClient = await CdpClient.connect(sidepanel.webSocketDebuggerUrl);
  await sidepanelClient.send('Runtime.enable');
  await sidepanelClient.send('Page.enable');
  await waitDocumentReady(sidepanelClient);

  if (!MINERU && !OFFLINE) {
    const absSmoke = await smokeArxivContent({
      port,
      sidepanelClient,
      url: 'https://arxiv.org/abs/1706.03762',
      expectedKind: 'abs',
    });
    results.push(`PASS arXiv /abs 抽取${absSmoke.injectedFallback ? '（自动注入未生效，使用构建产物注入）' : ''}`);

    const htmlSmoke = await smokeArxivContent({
      port,
      sidepanelClient,
      url: 'https://arxiv.org/html/2310.06825',
      expectedKind: 'html',
    });
    results.push(`PASS arXiv /html 抽取${htmlSmoke.injectedFallback ? '（自动注入未生效，使用构建产物注入）' : ''}`);

    if (PHASE_C) {
      await clickButton(sidepanelClient, '抽取本页');
      await waitForText(sidepanelClient, '已抽取：', 20_000);
      await clickButton(sidepanelClient, '公式推导');
      await clickButton(sidepanelClient, '生成推导');
      await waitForText(sidepanelClient, '目标公式', 15_000);
      const htmlFormulaDetail = await sidepanelClient.evaluate("document.body?.innerText || ''");
      if (!htmlFormulaDetail.includes('回跳原文') || htmlFormulaDetail.includes('AI 识别，实验性')) {
        throw new Error('网页真 LaTeX 公式 UI 被 PDF 实验性路径污染。');
      }
      results.push('PASS 网页真 LaTeX 公式与 DOM 回跳入口');
      await clickButton(sidepanelClient, '← 返回公式列表');
      await clickButton(sidepanelClient, '论文解读');
    }

    await smokeArxivPage({
      port,
      sidepanelClient,
      url: 'https://arxiv.org/pdf/1706.03762',
      buttonText: '解析本页 PDF',
      doneText: '已解析：',
      label: 'arXiv /pdf 解析',
      timeoutMs: 90_000,
    });
    results.push('PASS arXiv /pdf 解析（真实 pdf.js worker）');
  } else if (MINERU) {
    results.push('SKIP 公网页面回归（由 test:phase-c:browser 独立覆盖）');
  } else {
    results.push('SKIP 公网页面回归（--offline，仅验证上传与 file:// 路径）');
  }

  await activateTarget(port, sidepanel.id);
  await waitForText(sidepanelClient, '选择本地文件', 15_000);
  if (MINERU) {
    await sidepanelClient.evaluate(`chrome.storage.local.set({
      'paperlens.settings': {
        mineru: {
          enabled: true,
          port: ${mineruPort},
          accessToken: ${JSON.stringify(mineruToken)},
        },
      },
    })`);
  }
  await setFileInput(sidepanelClient, fixturePath);
  await waitFor(async () => {
    const title = await sidepanelClient.evaluate("document.querySelector('header p')?.textContent || ''");
    const body = await sidepanelClient.evaluate("document.body?.innerText || ''");
    return title.includes(path.basename(fixturePath)) && body.includes('已解析：');
  }, 90_000, '上传 PDF 解析');
  const uploadMetadata = await waitFor(
    () => sidepanelClient.evaluate(`(async () => {
      const entries = await chrome.storage.session.get(null);
      const paper = Object.values(entries)
        .map((entry) => entry?.paper)
        .find((item) => item?.url?.startsWith('pdf:') && item?.title === 'Attention Is All You Need');
      const sectionFormulaIds = [];
      const collectFormulaIds = (sections) => {
        for (const section of sections) {
          sectionFormulaIds.push(...section.formulaIds);
          collectFormulaIds(section.children);
        }
      };
      if (paper) collectFormulaIds(paper.sections);
      return paper ? {
        authors: paper.authors,
        pageCount: paper.pageCount,
        sections: paper.sections.length,
        formulaSupport: paper.formulaSupport,
        formulas: paper.formulas.map((formula) => ({
          id: formula.id,
          page: formula.page,
          confidence: formula.confidence,
          sectionPath: formula.sectionPath,
          context: formula.context,
          text: formula.latex,
        })),
        sectionFormulaIds,
      } : null;
    })()`),
    15_000,
    '上传 PDF 缓存元数据',
  );
  if (uploadMetadata.authors.length < 8) {
    throw new Error(`上传 PDF 作者识别不足：${JSON.stringify(uploadMetadata)}`);
  }
  results.push(`PASS 上传 PDF 解析与合成来源切换（${uploadMetadata.authors.length} 位作者）`);
  if (PHASE_C) {
    if (uploadMetadata.formulaSupport !== 'heuristic' || uploadMetadata.formulas.length === 0) {
      throw new Error(`真实 PDF 未产生可靠公式候选：${JSON.stringify(uploadMetadata)}`);
    }
    if (uploadMetadata.formulas.some((formula) => !formula.page || formula.confidence == null)) {
      throw new Error(`真实 PDF 公式缺少页码或置信度：${JSON.stringify(uploadMetadata.formulas.slice(0, 5))}`);
    }
    if (uploadMetadata.formulas.some((formula) => !formula.sectionPath || !formula.context)) {
      throw new Error(`真实 PDF 公式缺少章节路径或上下文：${JSON.stringify(uploadMetadata.formulas.slice(0, 5))}`);
    }
    if (uploadMetadata.formulas.some((formula) => !uploadMetadata.sectionFormulaIds.includes(formula.id))) {
      throw new Error(`真实 PDF 公式 ID 未写入章节树：${JSON.stringify(uploadMetadata)}`);
    }
    results.push(`PASS 真实 PDF 公式候选（${uploadMetadata.formulas.length} 条）`);
  }

  if (MINERU) {
    const mineruMetadata = await waitFor(
      () => sidepanelClient.evaluate(`(async () => {
        const entries = await chrome.storage.session.get(null);
        const paper = Object.values(entries)
          .map((entry) => entry?.paper)
          .find((item) => item?.url?.startsWith('pdf:') && item?.title === 'Attention Is All You Need');
        if (paper?.formulaSupport !== 'ocr') return null;
        const sectionFormulaIds = [];
        const collectFormulaIds = (sections) => {
          for (const section of sections) {
            sectionFormulaIds.push(...section.formulaIds);
            collectFormulaIds(section.children);
          }
        };
        collectFormulaIds(paper.sections);
        return {
          formulaSupport: paper.formulaSupport,
          formulas: paper.formulas.map((formula) => ({
            id: formula.id,
            recognitionSource: formula.recognitionSource,
            page: formula.page,
            bbox: formula.bbox,
            cropRef: formula.cropRef,
            sectionPath: formula.sectionPath,
          })),
          sectionFormulaIds,
          formulaRecognition: paper.formulaRecognition,
        };
      })()`),
      20 * 60_000,
      'MinerU OCR 完成',
    );
    if (mineruMetadata.formulas.length !== 5
      || mineruMetadata.formulaRecognition?.displayFormulaCount !== 5
      || mineruMetadata.formulaRecognition?.inlineFormulaCount !== 108) {
      throw new Error(`Attention MinerU 计数不符合金标基线：${JSON.stringify(mineruMetadata)}`);
    }
    if (mineruMetadata.formulaRecognition?.provider !== 'mineru-local'
      || mineruMetadata.formulas.some((formula) => formula.recognitionSource !== 'mineru-ocr')) {
      throw new Error(`MinerU 来源标识不完整：${JSON.stringify(mineruMetadata)}`);
    }
    if (mineruMetadata.formulas.some((formula) => !formula.page
      || !Array.isArray(formula.bbox)
      || formula.bbox.length !== 4
      || !formula.cropRef?.jobId
      || !formula.cropRef?.cropId
      || !formula.sectionPath
      || !mineruMetadata.sectionFormulaIds.includes(formula.id))) {
      throw new Error(`MinerU 公式缺少 page/bbox/crop/章节关联：${JSON.stringify(mineruMetadata)}`);
    }
    results.push('PASS MinerU Attention 原子增强（5 条展示公式，108 处行内统计）');

    await clickButton(sidepanelClient, '公式推导');
    await waitForText(sidepanelClient, 'MinerU 本地识别（OCR）', 15_000);
    await clickButton(sidepanelClient, '查看裁剪图核对');
    await waitFor(
      () => sidepanelClient.evaluate(`Boolean(document.querySelector('img[alt*="公式裁剪图"][src^="blob:"]'))`),
      15_000,
      'MinerU 裁剪图显示',
    );
    const mineruUi = await sidepanelClient.evaluate("document.body?.innerText || ''");
    if (!mineruUi.includes('正文另统计 108 处行内公式') || !/第 \d+ 页/.test(mineruUi)) {
      throw new Error('MinerU 公式列表未显示行内统计或页码定位。');
    }
    results.push('PASS MinerU 公式列表、page+bbox 元数据与鉴权裁剪图');
    await clickButton(sidepanelClient, '论文解读');
    await sidepanelClient.evaluate(`chrome.storage.local.set({
      'paperlens.settings': {
        mineru: {
          enabled: false,
          port: ${mineruPort},
          accessToken: ${JSON.stringify(mineruToken)},
        },
      },
    })`);
  }

  await setFileInput(sidepanelClient, singleColumnFixturePath);
  await waitFor(async () => {
    const title = await sidepanelClient.evaluate("document.querySelector('header p')?.textContent || ''");
    const body = await sidepanelClient.evaluate("document.body?.innerText || ''");
    return title.includes(path.basename(singleColumnFixturePath))
      && body.toLowerCase().includes('adam: a method for stochastic optimization');
  }, 90_000, '单栏 PDF 解析');
  results.push('PASS 单栏 PDF 真实解析（Adam）');

  const localPdf = await newTarget(port, pathToFileURL(fixturePath).href);
  await waitTargetLoaded(localPdf);
  await waitForText(sidepanelClient, '解析本页 PDF', 15_000);
  await clickButton(sidepanelClient, '解析本页 PDF');
  const localOutcome = await waitFor(async () => {
    const body = await sidepanelClient.evaluate("document.body?.innerText || ''");
    if (body.includes('允许访问文件网址')) return 'denied';
    if (body.includes('已解析：') && body.includes('重新解析')) return 'parsed';
    return '';
  }, 90_000, 'file:// 解析或权限提示');
  results.push(
    localOutcome === 'parsed'
      ? 'PASS file:// PDF 真实解析'
      : 'PASS file:// 未授权可操作错误',
  );

  await clickButton(sidepanelClient, '导出 Markdown');
  await waitForText(sidepanelClient, '推荐文件名', 15_000);
  const markdownPreview = await sidepanelClient.evaluate("document.querySelector('pre')?.textContent || ''");
  if (!markdownPreview.includes('Attention Is All You Need')) {
    throw new Error('PDF Markdown 导出预览缺少论文标题。');
  }
  results.push('PASS PDF Markdown 导出预览');

  if (PHASE_C) {
    await clickButton(sidepanelClient, '公式推导');
    await waitForText(sidepanelClient, 'AI 识别，实验性', 15_000);
    await clickButton(sidepanelClient, '生成推导');
    await waitForText(sidepanelClient, '疑似公式（原始 PDF 文本）', 15_000);
    const formulaDetail = await sidepanelClient.evaluate("document.body?.innerText || ''");
    if (!/第 \d+ 页/.test(formulaDetail) || formulaDetail.includes('回跳原文')) {
      throw new Error('PDF 公式详情未正确降级为页码定位。');
    }
    results.push('PASS 实验性公式标识与页码定位降级');

    const fakePortInstalled = await sidepanelClient.evaluate(`(() => {
      const messageListeners = [];
      const disconnectListeners = [];
      const fakeConnect = () => ({
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
        postMessage: (message) => {
          if (message.type !== 'start') return;
          window.__paperlensPhaseCPrompt = message;
          setTimeout(() => messageListeners.forEach((listener) => listener({
            type: 'ready', providerId: 'openai', model: 'phase-c-browser-mock'
          })), 0);
          setTimeout(() => messageListeners.forEach((listener) => listener({
            type: 'delta', content: '## 公式还原\\n\\nPhase C mock derivation complete'
          })), 10);
          setTimeout(() => messageListeners.forEach((listener) => listener({ type: 'done' })), 20);
        },
        disconnect: () => disconnectListeners.forEach((listener) => listener()),
      });
      try {
        Object.defineProperty(chrome.runtime, 'connect', { configurable: true, value: fakeConnect });
        return chrome.runtime.connect === fakeConnect;
      } catch {
        return false;
      }
    })()`);
    if (!fakePortInstalled) throw new Error('无法安装浏览器内 LLM Port 测试替身。');
    await clickButton(sidepanelClient, '生成推导');
    await waitForText(sidepanelClient, 'Phase C mock derivation complete', 15_000);
    const capturedPrompt = await sidepanelClient.evaluate('window.__paperlensPhaseCPrompt');
    const systemPrompt = capturedPrompt?.messages?.[0]?.content || '';
    const userPrompt = capturedPrompt?.messages?.[1]?.content || '';
    if (!systemPrompt.includes('先还原') || !userPrompt.includes('原始 PDF 公式文本') || !/页码：第 \d+ 页/.test(userPrompt)) {
      throw new Error(`浏览器推导链未发送 PDF heuristic prompt：${JSON.stringify(capturedPrompt)}`);
    }
    results.push('PASS PDF 先还原 prompt 与流式推导前端链路');
  }

  if (INTERACTIVE_PERMISSIONS) {
    const remoteOutcome = await smokeOptionalRemotePdf({
      port,
      sidepanelClient,
      url: fixtureServer.url,
    });
    results.push(
      remoteOutcome === 'parsed'
        ? 'PASS 任意在线 PDF 当前 origin 授权与解析'
        : 'PASS 任意在线 PDF 权限拒绝错误',
    );
  } else {
    results.push('SKIP 任意在线 PDF 权限弹窗（使用 --interactive-permissions 人工选择）');
  }

  const screenshot = await sidepanelClient.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(runDir, 'sidepanel-final.png'), Buffer.from(screenshot.data, 'base64'));
  process.stdout.write(`${JSON.stringify({ results, artifacts: runDir }, null, 2)}\n`);
} catch (error) {
  const bodyText = sidepanelClient
    ? await sidepanelClient.evaluate("document.body?.innerText || ''").catch(() => '')
    : '';
  process.stderr.write(
    `${JSON.stringify({ results, error: formatError(error), bodyText, artifacts: runDir }, null, 2)}\n`,
  );
  throw error;
} finally {
  await sidepanelClient?.close().catch(() => undefined);
  if (browserClient) {
    await browserClient.send('Browser.close').catch(() => undefined);
    await browserClient.close().catch(() => undefined);
  }
  await new Promise((resolve) => fixtureServer.server.close(resolve));
  if (!chrome.killed) chrome.kill();
}

async function smokeOptionalRemotePdf({ port: debugPort, sidepanelClient: panel, url }) {
  const target = await newTarget(debugPort, url);
  await waitTargetLoaded(target);
  await activateTarget(debugPort, target.id);
  await waitForText(panel, '解析本页 PDF', 20_000);
  const grantedBefore = await panel.evaluate(`chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })`);
  if (grantedBefore) throw new Error('临时 profile 在请求前已拥有测试 origin 权限。');
  await clickButton(panel, '解析本页 PDF');
  const outcome = await waitFor(async () => {
    const body = await panel.evaluate("document.body?.innerText || ''");
    if (body.includes('已解析：') && body.includes('重新解析')) return 'parsed';
    if (body.includes('未获得') && body.includes('访问权限')) return 'denied';
    return '';
  }, 90_000, '任意在线 PDF 权限结果');
  if (outcome === 'parsed') {
    const grantedAfter = await panel.evaluate(`chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] })`);
    if (!grantedAfter) throw new Error('在线 PDF 已解析，但当前 origin 权限未记录。');
  }
  return outcome;
}
}

async function smokeArxivPage({
  port: debugPort,
  sidepanelClient: panel,
  url,
  buttonText,
  doneText,
  label,
  timeoutMs = 45_000,
}) {
  const target = await newTarget(debugPort, url);
  await waitTargetLoaded(target);
  await activateTarget(debugPort, target.id);
  await waitForText(panel, buttonText, 20_000);
  await clickButton(panel, buttonText);
  await waitForText(panel, doneText, timeoutMs, label);
}

async function smokeArxivContent({ port: debugPort, sidepanelClient: panel, url, expectedKind }) {
  const target = await newTarget(debugPort, url);
  await waitTargetLoaded(target);
  await activateTarget(debugPort, target.id);
  await waitForText(panel, '抽取本页', 20_000);
  const response = await panel.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let injectedFallback = false;
    try {
      let result;
      try {
        result = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAPER' });
      } catch (error) {
        if (!String(error?.message || error).includes('Receiving end does not exist')) throw error;
        await chrome.tabs.reload(tab.id);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        try {
          result = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAPER' });
        } catch (reloadError) {
          if (!String(reloadError?.message || reloadError).includes('Receiving end does not exist')) throw reloadError;
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content-scripts/content.js'],
          });
          injectedFallback = true;
          result = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_PAPER' });
        }
      }
      return {
        tabUrl: tab.url,
        ok: result?.ok === true,
        error: result?.error || '',
        kind: result?.data?.kind || '',
        title: result?.data?.title || '',
        sectionCount: result?.data?.sections?.length || 0,
        injectedFallback,
      };
    } catch (error) {
      return { tabUrl: tab?.url || '', ok: false, error: error?.message || String(error) };
    }
  })()`);
  if (!response?.ok || response.kind !== expectedKind || !response.title) {
    throw new Error(`arXiv ${expectedKind} content 抽取失败：${JSON.stringify(response)}`);
  }
  return response;
}

async function clickButton(client, text) {
  const clicked = await client.evaluate(
    `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes(${JSON.stringify(text)})); if (!button) return false; button.click(); return true; })()`,
    true,
  );
  if (!clicked) throw new Error(`未找到按钮：${text}`);
}

async function waitForText(client, text, timeoutMs, label = text) {
  return waitFor(
    () => client.evaluate(`document.body?.innerText.includes(${JSON.stringify(text)}) || false`),
    timeoutMs,
    label,
  );
}

async function setFileInput(client, filePath) {
  await client.send('DOM.enable');
  const document = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const input = await client.send('DOM.querySelector', {
    nodeId: document.root.nodeId,
    selector: 'input[type=file]',
  });
  if (!input.nodeId) throw new Error('未找到 PDF 文件输入框。');
  await client.send('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [filePath] });
}

async function waitTargetLoaded(target) {
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send('Runtime.enable');
    await waitDocumentReady(client, 45_000);
  } finally {
    await client.close();
  }
}

async function waitDocumentReady(client, timeoutMs = 20_000) {
  return waitFor(
    () => client.evaluate("document.readyState === 'complete'"),
    timeoutMs,
    '页面加载完成',
  );
}

async function newTarget(debugPort, url) {
  const response = await fetch(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!response.ok) throw new Error(`创建浏览器标签失败：HTTP ${response.status}`);
  return response.json();
}

async function activateTarget(debugPort, targetId) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/activate/${targetId}`);
  if (!response.ok) throw new Error(`激活浏览器标签失败：HTTP ${response.status}`);
}

async function addTemporaryManifestKey(directory) {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.key = der.toString('base64');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return createHash('sha256')
    .update(der)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

async function downloadFixture(url, destination) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载冒烟 PDF 失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('冒烟文件不是有效 PDF。');
  }
  await writeFile(destination, buffer);
}

async function prepareFixture(localSource, url, destination) {
  if (!localSource) {
    await downloadFixture(url, destination);
    return;
  }
  const source = path.resolve(localSource);
  if (!existsSync(source)) throw new Error(`本地冒烟 PDF 不存在：${source}`);
  const prefix = Buffer.alloc(1024);
  const handle = await import('node:fs/promises').then(({ open }) => open(source, 'r'));
  try {
    const { bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0);
    if (!prefix.subarray(0, bytesRead).includes(Buffer.from('%PDF-'))) {
      throw new Error(`本地冒烟文件不是有效 PDF：${source}`);
    }
  } finally {
    await handle.close();
  }
  await cp(source, destination);
}

async function startPdfServer(filePath) {
  const pdf = await readFile(filePath);
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdf.byteLength,
      'Access-Control-Allow-Origin': '*',
    });
    response.end(pdf);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动测试 PDF 服务器。');
  return { server, url: `http://127.0.0.1:${address.port}/paper.pdf` };
}

async function getFreePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === 'string') throw new Error('无法分配调试端口。');
  return address.port;
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label}超时${lastError ? `：${formatError(lastError)}` : ''}`);
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
    });
    const rejectPending = () => {
      const error = new Error('Chrome DevTools 连接已断开。');
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
    socket.addEventListener('close', rejectPending);
    socket.addEventListener('error', rejectPending);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error('Chrome DevTools 连接不可用。'));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome DevTools 命令超时：${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async evaluate(expression, userGesture = false) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || '页面脚本执行失败。');
    }
    return response.result?.value;
  }

  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await new Promise((resolve) => this.socket.addEventListener('close', resolve, { once: true }));
  }
}

await main();
