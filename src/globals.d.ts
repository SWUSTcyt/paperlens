// 让 tsc 能识别非代码资源的 import，vite 会在构建时实际处理它们
declare module '*.css';
declare module '*.svg';
declare module '*.png';
