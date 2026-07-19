# PaperLens Phase B

目标：完成 PDF 摄入面扩展与版面/结构增强；不含 Phase C 公式识别。

- **B1 摄入权限**（完成）：任意 HTTP(S) PDF 按 origin 申请权限；`file://` 关闭时给可操作提示；错误可读。
- **B2 上传兜底**（完成）：选择/拖拽，键 `pdf:<name>:<size>:<sha256>`，二进制不入 storage。
- **B3 版面结构**（完成）：增强混合栏、页眉页脚、断词/段落、标题/作者/参考文献；失败降级纯文本。
- **B4 大文件体验**（完成）：逐页让出主线程并报告进度。
- **B5 验收**（完成）：17 项 PDF 单元/功能测试、`compile`、`build` 通过；Edge 真机覆盖 arXiv `/abs`/`/html`/`/pdf`、真实单双栏 PDF、上传、`file://`、Markdown 导出和任意在线 PDF 当前 origin 授权。
