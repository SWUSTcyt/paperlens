---
name: browser-extension-dev
description: Scaffold and iterate on modern Chrome / Firefox extensions (Manifest V3) with the WXT + React + TypeScript + Tailwind stack. Use when the user wants to create, modify, or debug a browser extension, mentions WXT, Manifest V3, SidePanel, content script, background service worker, or any Chrome extension API.
---

# Browser Extension Dev (WXT + React + TS + Tailwind)

Sourced from the PaperLens project. Covers scaffolding, architecture, messaging, LLM/BYOK integration, and common traps on Windows.

## When to apply

- User wants to build a Chrome/Edge/Firefox extension.
- User mentions: `manifest.json`, Manifest V3, WXT, SidePanel, content script, background service worker, `chrome.runtime`, `chrome.storage`, `chrome.downloads`, extension popup/options page, BYOK LLM extension.

## Golden rules

1. **Prefer WXT over raw Manifest V3**: auto manifest generation, file-system routed entrypoints, Vite-based HMR, zip packaging. Docs: <https://wxt.dev/>.
2. **One source of truth for manifest**: write `wxt.config.ts`, never hand-edit `.output/*/manifest.json` (regenerated every build).
3. **Don't put secrets (API keys) in the content script**. Keep them in `chrome.storage.local` and use only from the background / side panel.
4. **Use `chrome.runtime.connect` (Port) for streaming** (e.g. LLM SSE). Use `chrome.runtime.sendMessage` only for one-shot requests.
5. **Content Script ↔ DOM; SidePanel ↔ UI; Service Worker ↔ orchestration & network**. Do not call `fetch` to 3rd-party APIs from the content script (CORS + site CSP will bite you).

## Project scaffold (pnpm + WXT + React + Tailwind)

```bash
pnpm init
pnpm add react react-dom
pnpm add -D wxt @wxt-dev/module-react @types/react @types/react-dom @types/chrome typescript
pnpm add -D tailwindcss@^3 postcss autoprefixer
npx tailwindcss init -p
# esbuild builds native deps; allow it once:
pnpm approve-builds   # or add to package.json: pnpm.onlyBuiltDependencies: ["esbuild"]
```

### `package.json` scripts (minimum)

```json
{
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "dev:firefox": "wxt -b firefox",
    "build": "wxt build",
    "compile": "tsc --noEmit",
    "zip": "wxt zip",
    "postinstall": "wxt prepare"
  }
}
```

### `wxt.config.ts`

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: '.',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'MyExt',
    description: '...',
    permissions: ['sidePanel', 'storage', 'activeTab', 'scripting', 'downloads', 'tabs'],
    host_permissions: ['*://example.com/*'],
    action: { default_title: 'MyExt' },
  },
});
```

### `tsconfig.json`

Extend WXT's generated config and include JSX + chrome types:

```json
{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "types": ["chrome", "@wxt-dev/module-react", "wxt/vite-builder-env"]
  },
  "include": [".wxt/types/**/*.d.ts", "wxt.config.ts", "entrypoints/**/*", "src/**/*"]
}
```

### Tailwind + PostCSS

- `tailwind.config.js` content paths must include `./entrypoints/**/*.{html,ts,tsx}` and `./src/**/*.{ts,tsx}`.
- In `style.css`, third-party `@import` (e.g. `katex/dist/katex.min.css`) must appear **before** `@tailwind base;` or PostCSS will reject it.

## Entrypoint layout

```
entrypoints/
├── background.ts            # Service Worker
├── content.ts               # Content Script (arbitrary DOM target)
├── sidepanel/
│   ├── index.html
│   ├── main.tsx
│   └── App.tsx
└── options/
    ├── index.html
    ├── main.tsx
    └── Options.tsx
```

### Open SidePanel when user clicks the toolbar icon

```ts
// entrypoints/background.ts
export default defineBackground(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.warn);
});
```

## Messaging recipes

### One-shot: SidePanel → Content Script

```ts
// sender (sidepanel)
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const res = await chrome.tabs.sendMessage(tab!.id!, { type: 'EXTRACT_PAPER' });

// receiver (content.ts) — return `true` to keep sendResponse alive across async work
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type !== 'EXTRACT_PAPER') return false;
  try { sendResponse({ ok: true, data: doExtract() }); } catch (e: any) { sendResponse({ ok: false, error: e.message }); }
  return true;
});
```

### Streaming: SidePanel → Service Worker (Port + SSE)

Use a long-lived `Port`. Client side wraps it as an `AsyncGenerator`:

```ts
const port = chrome.runtime.connect({ name: 'my.llm' });
port.postMessage({ type: 'start', messages });
port.onMessage.addListener(msg => { /* queue → pull model */ });
port.onDisconnect.addListener(() => { /* finish */ });
// On abort: port.postMessage({ type: 'abort' }); port.disconnect();
```

Service Worker side manages the actual `fetch` + SSE parser so API keys stay out of the page context.

## Streaming-safe retry for LLM HTTP

Retry only **before** the response body starts streaming. Retry on `429 / 5xx` (not 501) and network `TypeError`. Once the `ReadableStream` begins, do not retry mid-stream.

```ts
async function fetchWithRetry(url: string, init: RequestInit & { maxRetries?: number } = {}) {
  const { maxRetries = 2, ...rest } = init;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await fetch(url, rest);
      if ((resp.status === 429 || (resp.status >= 500 && resp.status < 600 && resp.status !== 501)) && i < maxRetries) {
        await sleep(800 * 2 ** i + Math.random() * 200); continue;
      }
      return resp;
    } catch (err: any) {
      if (err?.name === 'AbortError') throw err;
      if (!(err instanceof TypeError) || i === maxRetries) throw err;
      await sleep(800 * 2 ** i);
    }
  }
  throw new Error('unreachable');
}
```

## BYOK LLM providers pattern

- One `Provider` interface: `{ meta, chat(config, req): AsyncIterable<ChatDelta> }`.
- Share an OpenAI-compatible adapter for OpenAI / DeepSeek / Qwen (DashScope 兼容模式 endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`).
- Anthropic is special: `x-api-key` header, `anthropic-version`, system as separate field, named SSE events (`content_block_delta`, `message_stop`), **and** the header `anthropic-dangerous-direct-browser-access: true` is required for extension direct calls.
- For DeepSeek reasoning models, yield `reasoning_content` as a separate `reasoning` delta — don't mix into user-visible content.

## Manifest host_permissions

Add one entry per LLM provider and one per site you intercept. Don't use `optional_host_permissions: ['*://*/*']` unless you really need it — triggers stricter Chrome Web Store review.

```ts
host_permissions: [
  '*://arxiv.org/*',
  'https://api.openai.com/*',
  'https://api.deepseek.com/*',
  'https://dashscope.aliyuncs.com/*',
  'https://api.anthropic.com/*',
]
```

## File download from SidePanel

```ts
const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
const url = URL.createObjectURL(blob);
await chrome.downloads.download({ url, filename, saveAs: true });
setTimeout(() => URL.revokeObjectURL(url), 60_000);
```

Note: `URL.createObjectURL` is **not** available in Service Workers in MV3. Trigger downloads from the SidePanel / Options page instead.

## Markdown + KaTeX rendering safely

1. Pre-process `$...$` and `$$...$$` into placeholder `<span data-pl-math="N">` (so `marked` doesn't wreck them).
2. `marked.parse(md, { async: false })` → `DOMPurify.sanitize(html, { ADD_ATTR: ['data-pl-math'] })`.
3. After sanitize, replace placeholders with `katex.renderToString(tex, { throwOnError: false, strict: 'ignore' })` (trusted output, no second sanitize needed).
4. Import `katex/dist/katex.min.css` **above** `@tailwind` directives.

## Common traps

- **`default_locale: 'zh_CN'` with no `_locales/` folder** → Chrome refuses to load. Either add the locale directory or drop the field.
- **`baseUrl` in `tsconfig.json`** triggers `TS5101 deprecated` with modern TS; WXT's base config already maps paths.
- **`esbuild` postinstall warning** on pnpm: add `"pnpm": { "onlyBuiltDependencies": ["esbuild"] }` in `package.json`.
- **Content Script fails to inject** until the tab is reloaded after install. Tell users to refresh the arXiv page once.
- **Options page 默认在 popup**. If the form is long, set `options_ui: { open_in_tab: true }` in the manifest / entrypoint meta.
- **Windows pnpm PATH**: if `pnpm` is missing, `npm install -g pnpm` — then restart the terminal so the new PATH is picked up.

## Verification checklist (before shipping)

```
- [ ] pnpm compile    # no TS errors
- [ ] pnpm build      # .output/chrome-mv3/manifest.json looks right
- [ ] Load unpacked   # SidePanel opens on the expected site
- [ ] Content Script  # refresh target page once, confirm messaging
- [ ] API keys        # only referenced from background / options context
- [ ] Logs            # no "[object Object]" in console.errors; wrap with err.message
```
