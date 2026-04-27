import { useState } from "react";
import page from "./Page.module.css";

export default function Report() {
  const [brief, setBrief] = useState("");

  return (
    <div>
      <h1 className={page.pageTitle}>报告撰写</h1>
      <p className={page.pageDesc}>
        选择模板与 case，将 ZIP / RAR 中的图片、数据与说明插入报告占位符；生成结果可再人工微调。大模型自动提纲功能已下线。
      </p>

      <div className={page.panel}>
        <label className={page.label}>报告需求 / 要点（手动整理）</label>
        <textarea
          className={page.textarea}
          placeholder="例如：PC1300 芯片 CDM 与 HBM 摸底结论写入「试验概述」「结论与建议」两章，语气正式…"
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          rows={5}
        />
        <p className={page.note} style={{ marginTop: "0.65rem" }}>
          当前版本不再调用大模型，请直接基于知识问答中的飞书引用内容手动整理提纲。
        </p>

        <label className={page.label} style={{ marginTop: "1.25rem" }}>
          报告模板（占位）
        </label>
        <input className={page.input} disabled placeholder="上传或链接 Word / 在线文档模板" />

        <label className={page.label} style={{ marginTop: "1rem" }}>
          证据压缩包（ZIP / RAR）
        </label>
        <input className={page.input} type="file" accept=".zip,.rar" disabled />

        <label className={page.label} style={{ marginTop: "1rem" }}>
          关联 case / 行号（来自登记表）
        </label>
        <input className={page.input} disabled placeholder="例如：CASE-2026-001" />

        <div className={page.row} style={{ marginTop: "1rem" }}>
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
