import page from "./Page.module.css";

export default function Visualization() {
  return (
    <div>
      <h1 className={page.pageTitle}>数据分析</h1>
      <p className={page.pageDesc}>
        读取与登记模块一致的表格数据源，做清洗、聚合与图表展示；图表类型与 KPI 可按后续业务指令扩展。
      </p>

      <div className={page.panel}>
        <label className={page.label}>数据源（表格链接）</label>
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
          图表画布与导出能力预留；待您提供指标定义、过滤维度与配色规范后实现。
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
