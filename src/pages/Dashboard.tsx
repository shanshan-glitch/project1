import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useFaHistoryRestore } from "@/hooks/useFaHistoryRestore";
import { appendWorkbenchHistory } from "@/lib/workbenchHistory";
import {
  IconChart,
  IconClipboard,
  IconFileText,
  IconIntelFeed,
  IconLibrary,
  IconMessage,
} from "@/components/icons/ModuleIcons";
import styles from "./Dashboard.module.css";

const modules = [
  {
    to: "/registration",
    title: "信息登记",
    description:
      "从文档链接抽取结构化字段，同步至共享登记表，形成可追溯 case 台账。",
    tag: "知识库",
    Icon: IconClipboard,
  },
  {
    to: "/report",
    title: "报告撰写",
    description:
      "按模板将 case 与 ZIP/RAR 证据填入指定章节，生成标准化 FA 报告草稿。",
    tag: "知识库",
    Icon: IconFileText,
  },
  {
    to: "/visualization",
    title: "数据分析",
    description: "基于登记表汇总、筛选与可视化，洞察批次问题与趋势。",
    tag: "知识库",
    Icon: IconChart,
  },
  {
    to: "/qa",
    title: "知识问答",
    description: "结合知识库与术语，支持流程、原理与术语等主题检索。",
    tag: "知识库",
    Icon: IconMessage,
  },
  {
    to: "/intel",
    title: "更多资讯",
    description:
      "AI 从网络检索芯片失效分析相关学术与公开资料，按策略捕获并同步至知识库分类。",
    tag: "AI 采集",
    Icon: IconIntelFeed,
  },
  {
    to: "/knowledge",
    title: "知识库",
    description: "链接学习 + 文件夹分类管理，构建可检索的企业知识底座。",
    tag: "底座",
    Icon: IconLibrary,
  },
] as const;

type DashboardHistorySnapshot = {
  module: "dashboard";
  v: 1;
  query: string;
};

function isDashboardSnapshot(s: unknown): s is DashboardHistorySnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return o.module === "dashboard" && o.v === 1 && typeof o.query === "string";
}

export default function Dashboard() {
  const [query, setQuery] = useState("");

  useFaHistoryRestore(
    "/",
    (snap) => {
      if (!isDashboardSnapshot(snap)) return;
      setQuery(snap.query);
    },
    isDashboardSnapshot,
  );

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) return;
    const t = window.setTimeout(() => {
      appendWorkbenchHistory({
        path: "/",
        moduleLabel: "总览",
        title: `搜索模块：${q.length > 28 ? `${q.slice(0, 28)}…` : q}`,
        snapshot: { module: "dashboard", v: 1, query },
      });
    }, 1200);
    return () => window.clearTimeout(t);
  }, [query]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return modules;
    return modules.filter((m) => {
      const hay = `${m.title} ${m.description} ${m.tag}`.toLowerCase();
      return hay.includes(q);
    });
  }, [query]);

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>企业工作台 · AI 辅助</p>
        <h1 className={styles.title}>
          <span className={styles.titleAccent}>FA</span> 数据平台
        </h1>
        <p className={styles.lead}>
          登记、报告、分析与问答共用知识库；「更多资讯」自动检索外部文献并可归档至分类文件夹。
        </p>
      </header>

      <div className={styles.toolbar}>
        <label className={styles.searchWrap}>
          <span className={styles.searchIcon} aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M11 19a8 8 0 100-16 8 8 0 000 16zm9 2l-4.35-4.35"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </span>
          <input
            type="search"
            className={styles.searchInput}
            placeholder="搜索模块名称、能力或标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className={styles.empty}>未找到匹配的模块，请调整关键词。</p>
      ) : (
        <ul className={styles.grid}>
          {filtered.map((m) => {
            const Icon = m.Icon;
            return (
              <li key={m.to}>
                <Link to={m.to} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.iconWrap} aria-hidden>
                      <Icon className={styles.icon} />
                    </span>
                    <span
                      className={m.tag === "底座" ? styles.tagMuted : styles.tag}
                    >
                      {m.tag}
                    </span>
                  </div>
                  <h2 className={styles.cardTitle}>{m.title}</h2>
                  <p className={styles.cardBody}>{m.description}</p>
                  <span className={styles.cardBtn}>
                    <span>进入模块</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M5 12h14m-7-7l7 7-7 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
