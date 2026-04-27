import { useState } from "react";
import page from "./Page.module.css";

export default function Visualization() {
  const [goal, setGoal] = useState("");

  return (
    <div>
      <h1 className={page.pageTitle}>数据分析</h1>
      <p className={page.pageDesc}>
        读取与登记模块一致的表格数据源，做清洗、聚合与图表展示。大模型分析说明功能已下线。
      </p>

      <div className={page.panel}>
        <label className={page.label}>分析目标 / 问题（手动整理）</label>
        <textarea
          className={page.textarea}
          placeholder="例如：按客户与批次统计近三个月 FA 结案周期分布，并识别异常长尾…"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          rows={4}
        />
        <p className={page.note} style={{ marginTop: "0.65rem" }}>
          当前版本不再调用大模型，请直接依据表格数据与知识问答引用内容制定分析方案。
        </p>

        <label className={page.label} style={{ marginTop: "1.25rem" }}>
          数据源（表格链接）
        </label>
        <input className={page.input} disabled placeholder="与「信息登记」共用的表格链接" />

        <div className={page.row} style={{ marginTop: "1rem" }}>
          <button type="button" className={page.btn} disabled>
            刷新数据
          </button>
          <button type="button" className={`${page.btn} ${page.btnPrimary}`} disabled>
            应用分析配置
          </button>
        </div>

        <p className={page.note} style={{ marginTop: "1.25rem" }}>
          图表画布与导出能力预留；实际指标以登记表数据为准。
        </p>

        <div
          aria-hidden
          style={{
            marginTop: "1rem",
            minHeight: 200,
            borderRadius: 8,
            background: "linear-gradient(160deg, #f1f5f9 0%, #e2e8f0 100%)",
            border: "1px dashed var(--border)",
          }}
        />
      </div>
    </div>
  );
}
