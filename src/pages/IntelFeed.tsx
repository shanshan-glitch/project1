import page from "./Page.module.css";
import styles from "./IntelFeed.module.css";

export default function IntelFeed() {
  return (
    <div>
      <h1 className={page.pageTitle}>更多资讯</h1>
      <p className={page.pageDesc}>
        由 AI
        按设定主题从开放网络检索芯片失效分析相关的学术论文、技术资料与行业文档，经去重与摘要后可同步至知识库对应分类。
      </p>

      <div className={styles.grid}>
        <section className={`${page.panel} ${styles.card}`}>
          <h2 className={styles.cardTitle}>检索与主题</h2>
          <p className={styles.cardHint}>
            可配置英文/中文关键词、机构、期刊偏好等；后端接入后将按合规来源抓取。
          </p>
          <label className={page.label} htmlFor="intel-keywords">
            关键词与主题（示意）
          </label>
          <textarea
            id="intel-keywords"
            className={page.textarea}
            rows={4}
            disabled
            placeholder="例如：integrated circuit failure analysis, bond wire fatigue, SEM FA case study..."
          />
          <label className={`${page.label} ${styles.mt}`} htmlFor="intel-scope">
            来源类型
          </label>
          <select id="intel-scope" className={styles.select} disabled>
            <option>学术论文（预印本 / 开放获取）</option>
            <option>行业白皮书与技术文章</option>
            <option>专利摘要（公开库）</option>
          </select>
        </section>

        <section className={`${page.panel} ${styles.card}`}>
          <h2 className={styles.cardTitle}>自动捕获策略</h2>
          <p className={styles.cardHint}>
            定时或增量拉取；新文献进入「待审」队列，确认后再写入知识库文件夹。
          </p>
          <label className={page.label} htmlFor="intel-cadence">
            更新频率
          </label>
          <select id="intel-cadence" className={styles.select} disabled>
            <option>每日增量</option>
            <option>每周汇总</option>
            <option>仅手动触发</option>
          </select>
          <div className={styles.row}>
            <button type="button" className={`${page.btn} ${page.btnPrimary}`} disabled>
              启动自动捕获
            </button>
            <button type="button" className={page.btn} disabled>
              立即检索一次
            </button>
          </div>
        </section>
      </div>

      <div className={`${page.panel} ${styles.capturePanel}`}>
        <h2 className={styles.sectionTitle}>最近捕获（占位）</h2>
        <p className={styles.empty}>接入检索与解析服务后，将在此展示标题、来源、摘要与入库状态。</p>
      </div>

      <p className={page.note} style={{ marginTop: "1rem" }}>
        本模块为交互原型：实际抓取需配置合法数据源、频率限制与贵司合规策略；可与「知识库」中文件夹联动自动归档。
      </p>
    </div>
  );
}
