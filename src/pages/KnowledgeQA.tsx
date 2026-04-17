import { useEffect, useState } from "react";
import { useFaHistoryRestore } from "@/hooks/useFaHistoryRestore";
import { appendWorkbenchHistory } from "@/lib/workbenchHistory";
import page from "./Page.module.css";
import styles from "./KnowledgeQA.module.css";

const topics = [
  { id: "flow", label: "分析流程" },
  { id: "principle", label: "测试原理" },
  { id: "terms", label: "专业术语速查" },
  { id: "cases", label: "典型案例要点" },
] as const;

type TopicId = (typeof topics)[number]["id"];

type QAHistorySnapshot = {
  module: "qa";
  v: 1;
  topic: TopicId;
  question: string;
};

function isQASnapshot(s: unknown): s is QAHistorySnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return o.module === "qa" && o.v === 1 && typeof o.topic === "string" && typeof o.question === "string";
}

export default function KnowledgeQA() {
  const [topic, setTopic] = useState<TopicId>("flow");
  const [question, setQuestion] = useState("");

  useFaHistoryRestore(
    "/qa",
    (snap) => {
      if (!isQASnapshot(snap)) return;
      setTopic(snap.topic);
      setQuestion(snap.question);
    },
    isQASnapshot,
  );

  useEffect(() => {
    const q = question.trim();
    if (q.length < 2) return;
    const t = window.setTimeout(() => {
      const label = topics.find((x) => x.id === topic)?.label ?? "知识问答";
      appendWorkbenchHistory({
        path: "/qa",
        moduleLabel: "知识问答",
        title: `草稿 · ${label}：${q.length > 36 ? `${q.slice(0, 36)}…` : q}`,
        snapshot: { module: "qa", v: 1, topic, question },
      });
    }, 1800);
    return () => window.clearTimeout(t);
  }, [topic, question]);

  return (
    <div>
      <h1 className={page.pageTitle}>知识问答</h1>
      <p className={page.pageDesc}>
        回答会优先引用知识库与术语表，减少口径偏差；子模块用于收窄检索范围，也便于新人分主题学习。
      </p>

      <div className={styles.topicBar} role="tablist" aria-label="问答子模块">
        {topics.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={topic === t.id}
            className={topic === t.id ? styles.topicActive : styles.topic}
            onClick={() => setTopic(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={page.panel}>
        <label className={page.label} htmlFor="qa-input">
          输入问题
        </label>
        <textarea
          id="qa-input"
          className={page.textarea}
          placeholder={
            topic === "terms"
              ? "例如：TEM 中的 EDS 线扫是什么？"
              : "例如：收到 FA 需求后第一步通常要确认哪些信息？"
          }
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />

        <div className={page.row}>
          <button type="button" className={`${page.btn} ${page.btnPrimary}`} disabled>
            提问（待接入模型与知识库）
          </button>
          <button type="button" className={page.btn} disabled>
            清空
          </button>
        </div>

        <p className={page.note} style={{ marginTop: "1rem" }}>
          当前为界面原型：接入文档解析、向量检索与引用片段展示后，即可在保持简洁的前提下逐步增强体验。
        </p>
      </div>
    </div>
  );
}
