import page from "./Page.module.css";

export default function Report() {
  return (
    <div>
      <h1 className={page.pageTitle}>报告撰写</h1>
      <p className={page.pageDesc}>
        选择模板与 case，将 ZIP / RAR 中的图片、数据与说明插入报告占位符；生成结果可再人工微调。
      </p>

      <div className={page.panel}>
        <label className={page.label}>报告模板（占位）</label>
        <input className={page.input} disabled placeholder="上传或链接 Word / 在线文档模板" />

        <label className={page.label} style={{ marginTop: "1rem" }}>
          证据压缩包（ZIP / RAR）
        </label>
        <input className={page.input} type="file" accept=".zip,.rar" disabled />

        <label className={page.label} style={{ marginTop: "1rem" }}>
          关联 case / 行号（来自登记表）
        </label>
        <input className={page.input} disabled placeholder="例如：CASE-2026-001" />

        <div className={page.row}>
          <button type="button" className={`${page.btn} ${page.btnPrimary}`} disabled>
            生成报告草稿
          </button>
        </div>

        <p className={page.note} style={{ marginTop: "1rem" }}>
          模板占位符命名、章节结构与压缩包目录约定，将在后续学习文档中固化后再实现自动化拼装。
        </p>
      </div>
    </div>
  );
}
