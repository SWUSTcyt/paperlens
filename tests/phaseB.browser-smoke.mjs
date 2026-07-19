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

async function main() {
const chromePath = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

if (!chromePath) throw new Error('未找到 Chrome/Edge；可通过 PAPERLENS_CHROME 指定路径。');

const workspace = path.resolve(import.meta.dirname, '..');
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
await downloadFixture('https://arxiv.org/pdf/1706.03762', fixturePath);
await downloadFixture('https://arxiv.org/pdf/1412.6980', singleColumnFixturePath);
const fixtureServer = await startPdfServer(fixturePath);

const logHandle = openSync(chromeLog, 'a');
const chrome = spawn(
  chromePath,
  [
    '--disable-gpu',
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

  await activateTarget(port, sidepanel.id);
  await waitForText(sidepanelClient, '选择本地文件', 15_000);
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
      return paper ? { authors: paper.authors, pageCount: paper.pageCount, sections: paper.sections.length } : null;
    })()`),
    15_000,
    '上传 PDF 缓存元数据',
  );
  if (uploadMetadata.authors.length < 8) {
    throw new Error(`上传 PDF 作者识别不足：${JSON.stringify(uploadMetadata)}`);
  }
  results.push(`PASS 上传 PDF 解析与合成来源切换（${uploadMetadata.authors.length} 位作者）`);

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
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
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
