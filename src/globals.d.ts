// 让 tsc 能识别非代码资源的 import，vite 会在构建时实际处理它们
declare module '*.css';
declare module '*.svg';
declare module '*.png';

// Vite 的 "?url" 资源导入：返回构建后可访问的 URL 字符串
// 用于 pdf.js 的 worker：import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
declare module '*?url' {
  const src: string;
  export default src;
}
