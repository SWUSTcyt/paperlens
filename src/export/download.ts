// 浏览器下载封装：把一段 Markdown 文本下载成 .md 文件
// 在 SidePanel 上下文里 URL.createObjectURL 可用；
// 对 Service Worker 则无 URL.createObjectURL，因此导出动作应在 SidePanel 触发。

export async function downloadMarkdown(
  markdown: string,
  filename: string,
  opts: { saveAs?: boolean } = {},
): Promise<number> {
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      saveAs: opts.saveAs ?? true,
    });
    return downloadId;
  } finally {
    // 下载启动后即可释放；Chrome 已把 blob 缓存到下载管理器
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
