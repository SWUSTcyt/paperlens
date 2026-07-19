// pdf.js 的懒加载与 Worker 配置
//
// 说明：
// - SidePanel 是拥有完整 DOM/Worker 的扩展页，可直接运行 pdf.js。
// - Worker 通过 Vite 的 "?url" 导入，构建后会输出为扩展内可访问的资源 URL
//   （chrome-extension://<id>/...），与 SidePanel 同源，无需 web_accessible_resources。
// - 主库用动态 import 懒加载，避免把体积较大的 pdf.js 打进 SidePanel 首屏。

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

type PdfjsModule = typeof import('pdfjs-dist');

let cached: Promise<PdfjsModule> | null = null;

/** 加载并初始化 pdf.js（只初始化一次，后续复用同一 Promise） */
export async function loadPdfjs(): Promise<PdfjsModule> {
  if (!cached) {
    cached = (async () => {
      const pdfjs = await import('pdfjs-dist');
      // 指定 Worker 脚本地址；不设置会回退到主线程解码（慢且可能报错）
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      return pdfjs;
    })();
  }
  return cached;
}
