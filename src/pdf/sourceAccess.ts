export type PdfSourceErrorCode =
  | 'permission-denied'
  | 'file-access-disabled'
  | 'not-pdf';

export class PdfSourceError extends Error {
  readonly code: PdfSourceErrorCode;

  constructor(message: string, code: PdfSourceErrorCode) {
    super(message);
    this.name = 'PdfSourceError';
    this.code = code;
  }
}

export interface PdfAccessApi {
  isFileAccessAllowed(): Promise<boolean>;
  requestOrigin(origin: string): Promise<boolean>;
}

/** 执行来源对应的最小授权流程；调用必须保留在用户点击事件链中。 */
export async function ensurePdfSourceAccess(
  kind: 'arxiv' | 'remote' | 'local' | 'none',
  origin: string | null,
  api: PdfAccessApi,
): Promise<void> {
  if (kind === 'local') {
    if (!(await api.isFileAccessAllowed())) {
      throw new PdfSourceError(
        'PaperLens 尚未获准读取本地文件。请打开扩展详情，开启「允许访问文件网址」后重试。',
        'file-access-disabled',
      );
    }
    return;
  }
  if (kind !== 'remote') return;
  if (!origin) throw new PdfSourceError('无法确定该 PDF 的站点权限。', 'not-pdf');
  // permissions.request 必须直接发生在用户手势链中；已授权 origin 会静默返回 true。
  if (!(await api.requestOrigin(origin))) {
    throw new PdfSourceError(`未获得 ${origin} 的访问权限，无法下载并解析该 PDF。`, 'permission-denied');
  }
}
