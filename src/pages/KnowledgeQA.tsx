import { useEffect, useMemo, useRef, useState } from "react";
import { useFaHistoryRestore } from "@/hooks/useFaHistoryRestore";
import { appendWorkbenchHistory } from "@/lib/workbenchHistory";
import { apiUrl, syncApiHeaders } from "@/lib/feishuApi";
import { getLearnedTextsForIds } from "@/lib/knowledgeLearnedTextDb";
import page from "./Page.module.css";
import styles from "./KnowledgeQA.module.css";

const topics = [
  { id: "flow", label: "分析流程" },
  { id: "principle", label: "测试原理" },
  { id: "terms", label: "专业术语速查" },
  { id: "cases", label: "典型案例要点" },
] as const;

type TopicId = (typeof topics)[number]["id"];

type FolderLite = { id: string; name: string };
type KnowledgeItemLite = {
  id: string;
  folderId: string;
  sourceType: "local_file" | "web_link" | "feishu_doc";
  title: string;
  url?: string;
  previewText?: string;
  /** 与知识库条目同步；正文实际在 IndexedDB，问答时会再拉取 */
  hasLearnedText?: boolean;
  createdAt: number;
};
type SourceMode = "single" | "multi";
type SourceId = "internet" | "kb_folder" | "feishu_drive";

type QAHistorySnapshotV2 = {
  module: "qa";
  v: 2;
  topic: TopicId;
  question: string;
  sourceMode: SourceMode;
  selectedSources: SourceId[];
  selectedFolderIds: string[];
};

type QAHistorySnapshotV1 = {
  module: "qa";
  v: 1;
  topic: TopicId;
  question: string;
};

type QASourceStore = {
  version: 1;
  sourceMode: SourceMode;
  selectedSources: SourceId[];
  selectedFolderIds: string[];
  feishuConnected: boolean;
  feishuLastSyncAt: number | null;
  feishuDocs: FeishuDoc[];
};

type QAResult = {
  answer: string;
  keyPoints: string[];
  refs: string[];
};

type QARecord = {
  id: string;
  ts: number;
  topic: TopicId;
  question: string;
  sources: SourceId[];
  folders: string[];
  result: QAResult;
  attachments: QAAttachment[];
};

type QAAttachment = {
  id: string;
  name: string;
  kind: "image" | "text";
  textPreview?: string;
};

type QASession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  records: QARecord[];
};

type FeishuDoc = {
  id: string;
  title: string;
  url: string;
  updatedAt: number;
};

type FeishuDocTextCache = Record<string, string>;
type WebSearchItem = { title: string; snippet: string; url?: string };

const KB_STORAGE_KEY = "fa-workbench-knowledge-db-v2";
const QA_SOURCE_STORAGE_KEY = "fa-workbench-qa-source-v1";
const QA_CHAT_STORAGE_KEY = "fa-workbench-qa-chat-v1";
const FEISHU_CACHE_KEY = "fa-workbench-feishu-readable-docs-v1";
const FEISHU_TEXT_CACHE_KEY = "fa-workbench-feishu-doc-text-v1";
const QA_CHAT_MAX = 50;

type QAChatStore = {
  version: 2;
  activeSessionId: string | null;
  sessions: QASession[];
};

const sourceOptions: Array<{ id: SourceId; label: string; desc: string }> = [
  { id: "internet", label: "联网检索", desc: "结合公开网页结果进行回答" },
  { id: "kb_folder", label: "知识库文件夹", desc: "仅检索你勾选的知识库分类" },
  { id: "feishu_drive", label: "飞书可读云文档", desc: "检索你在飞书云盘中有阅读权限的文档" },
];

function isQASnapshot(s: unknown): s is QAHistorySnapshotV1 | QAHistorySnapshotV2 {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  if (o.module !== "qa" || typeof o.topic !== "string" || typeof o.question !== "string") return false;
  return o.v === 1 || o.v === 2;
}

function readKnowledgeData(): { folders: FolderLite[]; items: KnowledgeItemLite[] } {
  try {
    const raw = localStorage.getItem(KB_STORAGE_KEY);
    if (!raw) return { folders: [], items: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { folders: [], items: [] };
    const o = parsed as Record<string, unknown>;
    if (o.version !== 2 || !Array.isArray(o.folders) || !Array.isArray(o.items)) return { folders: [], items: [] };
    const folders = (o.folders as Array<Record<string, unknown>>)
      .filter((f) => typeof f?.id === "string" && typeof f?.name === "string")
      .map((f) => ({ id: String(f.id), name: String(f.name) }));
    const items = (o.items as Array<Record<string, unknown>>)
      .filter(
        (it) =>
          typeof it?.id === "string" &&
          typeof it?.folderId === "string" &&
          typeof it?.title === "string" &&
          (it?.sourceType === "local_file" || it?.sourceType === "web_link" || it?.sourceType === "feishu_doc"),
      )
      .map((it) => ({
        id: String(it.id),
        folderId: String(it.folderId),
        sourceType: it.sourceType as KnowledgeItemLite["sourceType"],
        title: String(it.title),
        url: typeof it.url === "string" ? it.url : undefined,
        previewText: typeof it.previewText === "string" ? it.previewText : undefined,
        hasLearnedText: typeof it.hasLearnedText === "boolean" ? it.hasLearnedText : undefined,
        createdAt: typeof it.createdAt === "number" ? it.createdAt : 0,
      }));
    return { folders, items };
  } catch {
    return { folders: [], items: [] };
  }
}

function readQaSourceStore(): QASourceStore {
  try {
    const raw = localStorage.getItem(QA_SOURCE_STORAGE_KEY);
    if (!raw) {
      return {
        version: 1,
        sourceMode: "multi",
        selectedSources: ["kb_folder"],
        selectedFolderIds: [],
        feishuConnected: false,
        feishuLastSyncAt: null,
        feishuDocs: [],
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const o = parsed as Record<string, unknown>;
    const mode: SourceMode = o.sourceMode === "single" ? "single" : "multi";
    const selectedSources: SourceId[] = Array.isArray(o.selectedSources)
      ? (o.selectedSources.filter((x) => x === "internet" || x === "kb_folder" || x === "feishu_drive") as SourceId[])
      : ["kb_folder"];
    return {
      version: 1,
      sourceMode: mode,
      selectedSources: selectedSources.length ? selectedSources : ["kb_folder"],
      selectedFolderIds: Array.isArray(o.selectedFolderIds)
        ? o.selectedFolderIds.filter((x) => typeof x === "string")
        : [],
      feishuConnected: Boolean(o.feishuConnected),
      feishuLastSyncAt: typeof o.feishuLastSyncAt === "number" ? o.feishuLastSyncAt : null,
      feishuDocs: Array.isArray(o.feishuDocs)
        ? o.feishuDocs
            .filter(
              (x) =>
                x &&
                typeof x === "object" &&
                typeof (x as Record<string, unknown>).id === "string" &&
                typeof (x as Record<string, unknown>).title === "string" &&
                typeof (x as Record<string, unknown>).url === "string" &&
                typeof (x as Record<string, unknown>).updatedAt === "number",
            )
            .map((x) => x as FeishuDoc)
        : [],
    };
  } catch {
    return {
      version: 1,
      sourceMode: "multi",
      selectedSources: ["kb_folder"],
      selectedFolderIds: [],
      feishuConnected: false,
      feishuLastSyncAt: null,
      feishuDocs: [],
    };
  }
}

function formatTime(ts: number | null) {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function readFeishuDocCache(): { docs: FeishuDoc[]; lastSyncAt: number | null } {
  try {
    const raw = localStorage.getItem(FEISHU_CACHE_KEY);
    if (!raw) return { docs: [], lastSyncAt: null };
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return { docs: [], lastSyncAt: null };
    const o = parsed as Record<string, unknown>;
    const docs = Array.isArray(o.docs)
      ? (o.docs
          .filter(
            (x) =>
              x &&
              typeof x === "object" &&
              typeof (x as Record<string, unknown>).id === "string" &&
              typeof (x as Record<string, unknown>).title === "string" &&
              typeof (x as Record<string, unknown>).updatedAt === "number",
          )
          .map((x) => ({
            id: String((x as Record<string, unknown>).id),
            title: String((x as Record<string, unknown>).title),
            url: typeof (x as Record<string, unknown>).url === "string" ? String((x as Record<string, unknown>).url) : "",
            updatedAt: Number((x as Record<string, unknown>).updatedAt),
          })) as FeishuDoc[])
      : [];
    const lastSyncAt = typeof o.lastSyncAt === "number" ? o.lastSyncAt : null;
    return { docs, lastSyncAt };
  } catch {
    return { docs: [], lastSyncAt: null };
  }
}

function readFeishuTextCache(): FeishuDocTextCache {
  try {
    const raw = localStorage.getItem(FEISHU_TEXT_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const o = parsed as Record<string, unknown>;
    const next: FeishuDocTextCache = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && v.trim()) next[k] = v;
    }
    return next;
  } catch {
    return {};
  }
}

const STOP_WORDS = new Set([
  "这个",
  "那个",
  "以及",
  "然后",
  "如何",
  "什么",
  "情况",
  "问题",
  "请问",
  "当前",
  "什么样",
  "样子",
  "怎样",
]);

function extractKeywords(input: string) {
  const out = new Set<string>();
  const segment = input
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, " ")
    .split(/\s+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((s) => s.length >= 2)
    .filter((s) => !STOP_WORDS.has(s));
  for (const s of segment) out.add(s);
  const alnum = input.match(/[A-Za-z]{1,}\d+[A-Za-z0-9]*|[A-Z]{2,}\d+[A-Za-z0-9]*/g);
  if (alnum) {
    for (const x of alnum) out.add(x.toLowerCase());
  }
  return [...out].slice(0, 16);
}

function scoreTitle(title: string, keywords: string[]): number {
  const low = title.toLowerCase();
  let s = 0;
  for (const k of keywords) {
    if (k.length < 2) continue;
    if (low.includes(k)) s += k.length >= 6 ? 6 : 4;
  }
  return s;
}

function scoreBody(text: string, keywords: string[]): number {
  const low = text.toLowerCase().slice(0, 200000);
  let s = 0;
  for (const k of keywords) {
    if (k.length < 2) continue;
    if (low.includes(k)) s += 3;
  }
  return s;
}

function scoreSnippet(text: string, keywords: string[]): number {
  const low = text.toLowerCase();
  let s = 0;
  for (const k of keywords) {
    if (k.length < 2) continue;
    if (low.includes(k)) s += 1;
  }
  return s;
}

/**
 * 检索关键词策略：
 * 1) 当前问题关键词绝对优先（避免被历史问题型号污染）；
 * 2) 仅当当前关键词很少时，才补充少量历史关键词做兜底。
 */
function mergeKeywordsForRetrieval(question: string, records: QARecord[]): string[] {
  const current = extractKeywords(question);
  const set = new Set<string>(current);
  if (current.length < 4) {
    for (const r of records.slice(0, 2)) {
      for (const k of extractKeywords(r.question)) {
        if (set.has(k)) continue;
        set.add(k);
        if (set.size >= 12) break;
      }
      if (set.size >= 12) break;
    }
  }
  return [...set].slice(0, 20);
}

function chineseCharCount(s: string): number {
  return (s.match(/[\u4e00-\u9fa5]/g) || []).length;
}

/** 去除飞书正文里常见的附件文件名噪声（image.png、批量截图名等） */
function stripAttachmentNoise(text: string): string {
  let s = text || "";
  s = s.replace(/\b[\w.\-]+\.(png|jpg|jpeg|gif|webp|bmp|svg|zip|rar|csv|xlsx|xls|pdf)\b/gi, " ");
  s = s.replace(/\b(?:image|img|screenshot|snapshot)[_\-\s]?\d*\b/gi, " ");
  s = s.replace(/[\[\]{}<>]/g, " ");
  s = s.replace(/\s{2,}/g, " ");
  return s.trim();
}

function sanitizeSummaryLine(line: string): string {
  let t = (line || "").replace(/\s+/g, " ").trim();
  t = t.replace(/\b(?:FA\s*)?FA\d{8,}[A-Za-z0-9_\-./]{0,120}\b/gi, "");
  t = t.replace(/\b(?:HS|HSC|HSPC)[A-Za-z0-9_\-./]{8,}\b/g, "");
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function normalizeMetricToken(x: string): string {
  const t = x.toUpperCase().replace(/\s+/g, "");
  if (t === "L/U" || t === "LU") return "LU";
  return t;
}

function extractRequestedMetrics(question: string): string[] {
  const set = new Set<string>();
  const m = question.match(/\b(HBM|CDM|LU|L\/U|MM|ESD)\b/gi) || [];
  for (const x of m) set.add(normalizeMetricToken(x));
  if (set.size === 0) {
    set.add("HBM");
    set.add("CDM");
    set.add("LU");
  }
  return [...set];
}

function extractMetricHighlights(raw: string, metrics: string[]): string[] {
  if (!raw.trim()) return [];
  const out: string[] = [];
  const parts = raw
    .split(/(?<=[。！？.!?])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of parts) {
    const up = p.toUpperCase();
    const hitMetric = metrics.some((m) => {
      if (m === "LU") return /(?:\bLU\b|\bL\/U\b)/i.test(p);
      return up.includes(m);
    });
    if (!hitMetric) continue;
    if (!/[±+\-]?\d{2,5}\s*V/i.test(p) && !/(PASS|FAIL|通过|失败|待定|击穿|漏电|结果)/i.test(p)) continue;
    out.push(p);
    if (out.length >= 8) break;
  }
  return out;
}

function buildMetricConclusion(lines: string[], metrics: string[]): string {
  const hit: string[] = [];
  const miss: string[] = [];
  for (const m of metrics) {
    const ok = lines.some((ln) => {
      const u = ln.toUpperCase();
      if (m === "LU") return /(?:\bLU\b|\bL\/U\b)/i.test(ln);
      return u.includes(m);
    });
    if (ok) hit.push(m);
    else miss.push(m);
  }
  if (hit.length > 0 && miss.length === 0) return `已提取到 ${hit.join("、")} 的正文信息，结论见上方分点。`;
  if (hit.length > 0) return `已提取到 ${hit.join("、")} 的正文信息；${miss.join("、")} 在当前抓取正文中未明确出现。`;
  return "当前抓取正文未明确出现所问指标字段，建议补充更精确关键词或检查文档是否以图片为主。";
}

/** 过滤飞书导出里常见的「仅文件名 / 附件清单」行，避免当作正文要点 */
function looksLikeFilenameNoise(s: string): boolean {
  const t = s.trim();
  if (t.length < 10) return true;
  const cn = chineseCharCount(t);
  if (cn >= 14) return false;
  const fileHits = (t.match(/\b[\w.\-]+\.(png|jpg|jpeg|gif|webp|bmp|svg|xlsx|xls|csv|pdf|zip|rar)\b/gi) || []).length;
  if (fileHits >= 2) return true;
  if (fileHits >= 1 && cn < 16) return true;
  if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|xlsx|xls|csv|pdf|zip|rar)(\b|[\]"'\s])/i.test(t) && cn < 8) return true;
  if (/^(png|jpg|jpeg|xlsx|pdf|csv)\s+/i.test(t)) return true;
  if (/^(打开|切片|截图|image|img)\b/i.test(t) && cn < 10) return true;
  if (/^[a-z0-9_\-\s./\\:+]{10,}$/i.test(t) && cn < 4) return true;
  if (!/[。；;，,]/.test(t) && t.length > 220 && cn < 20) return true;
  return false;
}

/** 除句号切分外，按换行、分号切分，适配无标点的大段正文 */
function chunkEvidenceText(blob: string): string[] {
  const normalized = stripAttachmentNoise(blob.replace(/\r\n/g, "\n")).trim();
  if (!normalized) return [];
  const parts = new Set<string>();
  for (const s of normalized.split(/(?<=[。！？.!?])/)) {
    const t = s.trim();
    if (t.length >= 14 && !looksLikeFilenameNoise(t)) parts.add(t);
  }
  for (const line of normalized.split(/\n+/)) {
    const t = line.trim();
    if (t.length >= 18 && !looksLikeFilenameNoise(t)) parts.add(t);
  }
  for (const seg of normalized.split(/[；;]\s*/)) {
    const t = seg.trim();
    if (t.length >= 18 && !looksLikeFilenameNoise(t)) parts.add(t);
  }
  for (const seg of normalized.split(/[，,]\s*/)) {
    const t = seg.trim();
    if (t.length >= 20 && t.length <= 180 && !looksLikeFilenameNoise(t)) parts.add(t);
  }
  return [...parts];
}

function trimExcerpt(s: string, max = 420): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 问句关键词在标题/正文中的命中强度，用于过滤「标题擦边但正文无关」的文档 */
function evidenceKeywordHits(title: string, body: string, kws: string[]): number {
  const tl = title.toLowerCase();
  const bl = body.slice(0, 150000).toLowerCase();
  let n = 0;
  for (const k of kws) {
    if (k.length < 2) continue;
    const kk = k.toLowerCase();
    if (tl.includes(kk)) n += 2;
    if (bl.includes(kk)) n += 1;
  }
  return n;
}

/** 型号/项目代号类关键词，用于剔除仅泛泛命中「ESD」等通用词的其他型号文档 */
function coreProductTokens(kws: string[]): string[] {
  return kws.filter((k) => /[a-z]+\d|[a-z]*\d{3,}[a-z0-9]*/i.test(k));
}

function matchesCoreProduct(title: string, body: string, cores: string[]): boolean {
  if (cores.length === 0) return true;
  const t = `${title}\n${body.slice(0, 80000)}`.toLowerCase();
  return cores.some((c) => t.includes(c.toLowerCase()));
}

function dedupeSimilarLines(lines: string[], maxKeep: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const t = line.replace(/\s+/g, " ").trim();
    if (t.length < 8) continue;
    const key = t.replace(/\s+/g, "").slice(0, 48).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxKeep) break;
  }
  return out;
}

/** 从正文中抽取与关键词强相关的短句，避免把整段参数表原样贴出 */
function pickSummaryLines(blob: string, kws: string[], maxLines: number): string[] {
  const raw = stripAttachmentNoise((blob || "").trim());
  if (!raw) return [];
  const candidates = new Set<string>();
  for (const s of chunkEvidenceText(raw)) {
    if (!looksLikeFilenameNoise(s) && scoreSnippet(s, kws) >= 1) candidates.add(s.trim());
  }
  for (const s of bestSentences(raw, kws, 10)) {
    if (!looksLikeFilenameNoise(s) && scoreSnippet(s, kws) >= 1) candidates.add(s.trim());
  }
  const scored = [...candidates].map((s) => ({
    s,
    sc: scoreSnippet(s, kws) * 4 + Math.min(s.length / 100, 2) + (/\d/.test(s) ? 0.4 : 0),
  }));
  scored.sort((a, b) => b.sc - a.sc);
  const picked = dedupeSimilarLines(
    scored.map((x) => x.s),
    maxLines,
  );
  if (picked.length > 0) return picked;
  // 若关键词命中弱，退化到较干净的句子提炼，避免输出空结论
  const fallback = dedupeSimilarLines(
    bestSentences(raw, kws, Math.max(4, maxLines * 2)).filter((s) => !looksLikeFilenameNoise(s)),
    maxLines,
  );
  return fallback;
}

function bestSentences(text: string, keywords: string[], max = 3) {
  const source = text.replace(/\s+/g, " ").trim();
  if (!source) return [];
  const parts = source.split(/(?<=[。！？.!?])/).map((s) => s.trim()).filter(Boolean);
  const scored = parts
    .map((s) => {
      const low = s.toLowerCase();
      let score = 0;
      for (const k of keywords) if (low.includes(k)) score += 3;
      score += Math.max(0, 1 - Math.abs(s.length - 42) / 80);
      return { s, score };
    })
    .sort((a, b) => b.score - a.score);
  const out: string[] = [];
  for (const item of scored) {
    if (item.s.length < 10) continue;
    out.push(item.s);
    if (out.length >= max) break;
  }
  return out;
}

function createEmptySession(): QASession {
  const now = Date.now();
  return {
    id: makeId(),
    title: "新对话",
    createdAt: now,
    updatedAt: now,
    records: [],
  };
}

function readQaChatStore(): QAChatStore {
  try {
    const raw = localStorage.getItem(QA_CHAT_STORAGE_KEY);
    if (!raw) {
      const first = createEmptySession();
      return { version: 2, activeSessionId: first.id, sessions: [first] };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid");
    const o = parsed as Record<string, unknown>;
    if (o.version !== 2 || !Array.isArray(o.sessions)) throw new Error("invalid");
    const sessions = (o.sessions as Array<Record<string, unknown>>)
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.records))
      .map((s) => ({
        id: String(s.id),
        title: typeof s.title === "string" ? s.title : "未命名对话",
        createdAt: typeof s.createdAt === "number" ? s.createdAt : Date.now(),
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : Date.now(),
        records: (s.records as Array<Record<string, unknown>>)
          .filter((x) => x && typeof x.id === "string" && typeof x.question === "string" && x.result)
          .map((x) => ({
            id: String(x.id),
            ts: typeof x.ts === "number" ? x.ts : Date.now(),
            topic: (typeof x.topic === "string" ? x.topic : "flow") as TopicId,
            question: String(x.question),
            sources: Array.isArray(x.sources)
              ? (x.sources.filter((id) => id === "internet" || id === "kb_folder" || id === "feishu_drive") as SourceId[])
              : [],
            folders: Array.isArray(x.folders) ? x.folders.filter((f) => typeof f === "string") : [],
            attachments: Array.isArray(x.attachments)
              ? x.attachments
                  .filter(
                    (a) =>
                      a &&
                      typeof a === "object" &&
                      typeof (a as Record<string, unknown>).id === "string" &&
                      typeof (a as Record<string, unknown>).name === "string" &&
                      ((a as Record<string, unknown>).kind === "image" || (a as Record<string, unknown>).kind === "text"),
                  )
                  .map((a) => ({
                    id: String((a as Record<string, unknown>).id),
                    name: String((a as Record<string, unknown>).name),
                    kind: ((a as Record<string, unknown>).kind as "image" | "text"),
                    textPreview:
                      typeof (a as Record<string, unknown>).textPreview === "string"
                        ? String((a as Record<string, unknown>).textPreview)
                        : undefined,
                  }))
              : [],
            result: x.result as QAResult,
          })),
      }));
    if (sessions.length === 0) {
      const first = createEmptySession();
      return { version: 2, activeSessionId: first.id, sessions: [first] };
    }
    const active = typeof o.activeSessionId === "string" ? o.activeSessionId : sessions[0].id;
    return { version: 2, activeSessionId: active, sessions };
  } catch {
    const first = createEmptySession();
    return { version: 2, activeSessionId: first.id, sessions: [first] };
  }
}

function toAnswerPlainText(r: QARecord) {
  const lines: string[] = [];
  lines.push(`时间：${formatTime(r.ts)}`);
  lines.push(`问题：${r.question}`);
  lines.push(`来源：${r.sources.map((s) => sourceLabel(s)).join(" + ")}`);
  lines.push(`回答：${r.result.answer}`);
  if (r.result.keyPoints.length > 0) {
    lines.push("要点：");
    for (const p of r.result.keyPoints) lines.push(`- ${p}`);
  }
  if (r.result.refs.length > 0) {
    lines.push("引用：");
    for (const ref of r.result.refs) lines.push(`- ${ref}`);
  }
  return lines.join("\n");
}

function sourceLabel(id: SourceId) {
  if (id === "internet") return "联网检索";
  if (id === "kb_folder") return "知识库文件夹";
  return "飞书可读云文档";
}

type EvidenceItem = { source: string; title: string; text: string; url?: string };

/** 英文技术句为主（无大模型时用于切换「中文导读」版式） */
function isMostlyEnglishTechnicalLine(s: string): boolean {
  const t = (s || "").replace(/\s+/g, " ").trim();
  if (t.length < 16) return false;
  const cn = chineseCharCount(t);
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  return cn < 12 && letters > Math.max(24, cn * 4);
}

function inferDomainChineseIntro(question: string, evidence: EvidenceItem[]): string {
  const blob = `${question}\n${evidence.map((e) => e.title).join(" ")}`.toLowerCase();
  if (/j[\s\-]*std[\s\-]*020|jstd[\s\-]*020|ipc\/jedec\s*j[\s\-]*std[\s\-]*020/.test(blob)) {
    return "您提到的是 **IPC/JEDEC J-STD-020** 系列（行业常称「潮敏 / 回流敏感」相关联标）。其核心是把表面贴装元器件按**车间暴露、干燥烘烤与回流焊热历程**等风险进行分级（常见如 **MSL：潮敏等级**），并对标签、工艺窗口与试验流程给出一致化要求。不同版次（D/E/F…）在极限温度、时间与判定细节上会有修订，**最终以您打开的对应版次 PDF 表格与脚注为准**。";
  }
  if (/jedec|ipc\/jedec|ipc\//.test(blob)) {
    return "检索命中多为 **IPC/JEDEC** 等英文行业标准或应用笔记，正文常以**参数表与条款编号**呈现。下面用中文做**结构化导读**，避免把大段英文直接堆叠；需要逐句翻译时，请结合下方引用在 PDF 中定位条款。";
  }
  if (/mil[\s\-]*std|iec\s*\d|gb\/t|gjb/.test(blob)) {
    return "命中文献属于**标准/规范类英文文本**。以下用中文概括可读片段中的主题线索；**限值、试验条件与判定语句请以原文为准**。";
  }
  return "以下材料来自知识库，正文多为**英文技术描述**。将以**中文导读 + 极短原文摘录**的方式整理，便于先建立概念框架；细节与数值请对照原文。";
}

function technicalHintsZhFromLine(line: string, kws: string[]): string {
  const l = line.slice(0, 800);
  const hits: string[] = [];
  if (/MSL\s*\d?/i.test(l)) hits.push("潮敏等级（MSL）");
  if (/reflow\s*sensitivity|sensitivity\s*classification|moisture\s*\/\s*reflow/i.test(l)) hits.push("回流敏感度分级");
  if (/moisture|humidity|floor\s*life|soak|baking|dry\s*pack/i.test(l)) hits.push("吸潮、车间暴露与烘烤/干燥包装");
  if (/\b\d{2,4}\s*°?\s*C\b/i.test(l)) hits.push("温度或热曲线相关参数");
  if (/package|component|device|body|terminal/i.test(l)) hits.push("封装/器件本体与端子要求");
  if (/peak\s*temperature|ramp|preheat|time\s*above|TAL/i.test(l)) hits.push("回流曲线各阶段（预热/峰值/液相以上时间等）");
  const kwHit = kws.filter((k) => k.length > 1 && l.toLowerCase().includes(k.toLowerCase())).slice(0, 8);
  const core = hits.length ? `该句段主要涉及 **${hits.join("、")}** 。` : "该句段包含多项工艺/分级相关英文术语。";
  const kwPart = kwHit.length ? `与本次检索词「${kwHit.join("、")}」在字面上有直接命中。` : "";
  return `${core}${kwPart}`;
}

function lineToChineseDigest(line: string, kws: string[]): string {
  const t = line.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const cn = chineseCharCount(t);
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  if (cn >= 14 && cn >= letters / 5) {
    return trimExcerpt(t, 200);
  }
  if (isMostlyEnglishTechnicalLine(t)) {
    return `${technicalHintsZhFromLine(t, kws)}（英文缩写摘录：${trimExcerpt(t, 88)}）`;
  }
  return trimExcerpt(t, 200);
}

function formatChineseSynthesisAnswer(p: {
  topicLabel: string;
  question: string;
  narrativeLines: string[];
  evidence: EvidenceItem[];
  ctxBlock: string;
  refs: string[];
  kws: string[];
}): QAResult {
  const { topicLabel, question, narrativeLines, evidence, ctxBlock, refs, kws } = p;
  const intro = inferDomainChineseIntro(question, evidence);
  const numberedZh =
    narrativeLines.length > 0
      ? narrativeLines.map((l, i) => `${i + 1}）${lineToChineseDigest(l, kws)}`).join("\n\n")
      : "未能从正文中稳定切分出要点句（可能以表格/扫描图为主）。建议打开下方引用 PDF，从目录与第 1 章总述开始阅读。";

  const enExcerpts = narrativeLines
    .filter((l) => isMostlyEnglishTechnicalLine(l))
    .slice(0, 2)
    .map((l) => trimExcerpt(l, 105));

  const answer =
    `【${topicLabel}】${intro}\n\n` +
    `**针对您的问题（中文）**：已结合检索词「${kws.slice(0, 10).join("、") || "自动提取"}」对知识库可读正文做**中文导读**（当前为**无大模型**模式：不做全文机译，以降低误译数值与条款的风险）。\n\n` +
    `${ctxBlock}${numberedZh}` +
    (enExcerpts.length > 0
      ? `\n\n—— **英文原文缩写（仅供核对，不能替代通读标准）** ——\n${enExcerpts.map((x, i) => `${i + 1}. ${x}`).join("\n")}`
      : "") +
    `\n\n如需「逐段中译」或更口语的二次总结，可在部署环境中接入合规的大模型摘要接口；当前版本在离线规则下尽量保证**中文叙述结构**与引用可追溯。`;

  const keyPoints = narrativeLines
    .map((l) => lineToChineseDigest(l, kws))
    .filter(Boolean)
    .slice(0, 6);
  return {
    answer,
    keyPoints: keyPoints.length ? keyPoints : ["已根据检索词生成中文导读；原文多为英文标准条款。", "请结合下方引用打开 PDF，核对表格中的极限值与脚注。"],
    refs: refs.length ? refs : [],
  };
}

function buildSynthesizedAnswer(params: {
  topic: TopicId;
  question: string;
  evidence: EvidenceItem[];
  dialogContext: string;
  searchKeywords: string[];
}): QAResult {
  const { topic, question, evidence, dialogContext, searchKeywords } = params;
  const topicLabel = topics.find((t) => t.id === topic)?.label ?? "知识问答";
  const kws = searchKeywords.length ? searchKeywords : extractKeywords(question);
  type SnippetRef = { text: string; source: string; title: string; url?: string; score: number };
  const pool: SnippetRef[] = [];

  for (const e of evidence) {
    const blob = (e.text || "").trim() || e.title;
    const chunks = chunkEvidenceText(blob);
    for (const s of chunks) {
      const sc = scoreSnippet(s, kws);
      if (sc < 1) continue;
      if (looksLikeFilenameNoise(s)) continue;
      pool.push({ text: s, source: e.source, title: e.title, url: e.url, score: sc });
    }
    for (const s of bestSentences(blob, kws, 6)) {
      const sc = scoreSnippet(s, kws);
      if (sc < 1) continue;
      if (looksLikeFilenameNoise(s)) continue;
      pool.push({ text: s, source: e.source, title: e.title, url: e.url, score: sc + 0.35 });
    }
  }

  pool.sort((a, b) => b.score - a.score);
  const dedupText = new Set<string>();
  const strong: SnippetRef[] = [];
  for (const x of pool) {
    const key = `${x.title}::${x.text.slice(0, 100)}`;
    if (dedupText.has(key)) continue;
    dedupText.add(key);
    strong.push(x);
    if (strong.length >= 20) break;
  }

  const ctxBlock = dialogContext.trim() ? `${dialogContext.trim()}\n\n` : "";

  if (strong.length === 0) {
    const feishuFirst = [
      ...evidence.filter((e) => e.source === "飞书云文档"),
      ...evidence.filter((e) => e.source !== "飞书云文档"),
    ];
    const fallbackDocs = feishuFirst.slice(0, 3);
    const isZhQ = chineseCharCount(question) >= 2;
    const fallbackSummary = fallbackDocs
      .map((e, i) => {
        const sentences = bestSentences((e.text || "").trim(), kws, 2);
        const body = sentences.length
          ? sentences.map((x) => (isZhQ ? lineToChineseDigest(x, kws) : trimExcerpt(x, 180))).join("；")
          : isZhQ
            ? lineToChineseDigest(
                trimExcerpt((e.text || e.title || "材料内容较少").replace(/\s+/g, " "), 400),
                kws,
              )
            : trimExcerpt((e.text || e.title || "材料内容较少").replace(/\s+/g, " "), 180);
        return `${i + 1}）《${e.title}》：${body}`;
      })
      .join("\n\n");
    const fallbackRefs = fallbackDocs
      .filter((e) => e.url || e.title)
      .map((e) => `${e.source}《${e.title}》${e.url ? `（${e.url}）` : ""}`);
    return {
      answer: isZhQ
        ? fallbackSummary
          ? `【中文导读】${inferDomainChineseIntro(question, fallbackDocs)}\n\n关键词命中偏弱，以下为基于材料的结构化导读：\n\n${ctxBlock}${fallbackSummary}\n\n建议在追问中补充标准号、章节或具体试验项，以便更精准提炼。`
          : `【中文导读】在「${topicLabel}」场景下未筛出与检索词（${kws.slice(0, 8).join("、") || "…"}）足够匹配的句段。${ctxBlock}${inferDomainChineseIntro(
              question,
              evidence,
            )}请补充如 **标准号**、**MSL**、**回流** 等更具体的词，或从下方引用打开文档查阅目录。`
        : fallbackSummary
          ? `【分析梳理】基于本轮已抓取的材料先做整理：\n\n${ctxBlock}${fallbackSummary}\n\n（当前关键词命中较弱，建议在追问中补充型号/测试项，以便更精准提炼。）`
          : `在「${topicLabel}」场景下检索了所选来源，但没有筛出与当前问题关键词（${kws.slice(0, 8).join("、") || "…"}）足够匹配的正文句段。${ctxBlock}请补充型号/试验项等具体词，或通过下方引用打开文档自行核对。`,
      keyPoints: isZhQ
        ? [
            "关键词命中偏弱时已改为中文导读版式，避免大段英文原文。",
            "材料若以表格/扫描图为主，自动抽句可能较少；请结合引用 PDF 核对。",
          ]
        : [
            "材料中可能以表格/图片为主，当前仅解析正文与可分段文字。",
            "追问时请沿用上一轮里的型号、项目代号，便于继续对齐检索。",
          ],
      refs: fallbackRefs.length
        ? fallbackRefs
        : evidence
        .filter((e) => e.url && evidenceKeywordHits(e.title, e.text, kws) >= 3)
        .slice(0, 3)
        .map((e) => `${e.source}《${e.title}》${e.url ? `（${e.url}）` : ""}`),
    };
  }

  /** 按文档聚合得分，优先保留与问句关键词结合最紧的少量材料 */
  const docScore = new Map<string, number>();
  for (const x of strong) {
    docScore.set(x.title, (docScore.get(x.title) ?? 0) + x.score);
  }
  const rankedDocs = [...docScore.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const topTitles = new Set(rankedDocs.map(([t]) => t));

  const linesOut: string[] = [];
  for (const title of topTitles) {
    const e = evidence.find((it) => it.title === title);
    if (!e) continue;
    const picked = pickSummaryLines(e.text || e.title, kws, 4);
    for (const ln of picked) linesOut.push(ln);
  }
  const narrativeLines = dedupeSimilarLines(linesOut, 8);

  const refs = evidence
    .filter((e) => topTitles.has(e.title) && (e.url || e.title))
    .sort((a, b) => {
      const aw = a.source === "飞书云文档" ? 0 : 1;
      const bw = b.source === "飞书云文档" ? 0 : 1;
      return aw - bw;
    })
    .slice(0, 4)
    .map((e) => `${e.source}《${e.title}》${e.url ? `（${e.url}）` : ""}`);

  if (chineseCharCount(question) >= 2) {
    return formatChineseSynthesisAnswer({
      topicLabel,
      question,
      narrativeLines,
      evidence,
      ctxBlock,
      refs,
      kws,
    });
  }

  const head = `【${topicLabel}】基于已抓取材料的归纳结论如下：`;
  const numbered =
    narrativeLines.length > 0
      ? `\n\n${narrativeLines.map((l, i) => `${i + 1}）${trimExcerpt(l, 260)}`).join("\n\n")}`
      : "\n\n（可抽取的短句较少，建议打开引用文档查看表格与图片结论。）";
  const answer = `${head}\n\n${ctxBlock}${numbered}\n\n以上由抓取内容自动归纳，建议结合下方引用文档核对。`;

  const keyPoints = narrativeLines.slice(0, 6).map((l) => trimExcerpt(l.replace(/\s+/g, " "), 130));

  return {
    answer,
    keyPoints: keyPoints.length ? keyPoints : [trimExcerpt(narrativeLines[0] || question, 120)],
    refs: refs.length ? refs : [`${strong[0].source}《${strong[0].title}》${strong[0].url ? `（${strong[0].url}）` : ""}`],
  };
}

/**
 * 无大模型时的稳定兜底：仅基于飞书文档抽句归纳，避免被历史问答/附件噪声污染。
 * 输出风格尽量贴近旧版本：归纳说明 + 分点 + 引用来源（可打开）。
 */
function buildFeishuDeterministicSummary(question: string, feishuEvidence: EvidenceItem[], kws: string[]): QAResult {
  const docs = feishuEvidence.filter((e) => (e.url || "").trim().length > 0).slice(0, 4);
  const metrics = extractRequestedMetrics(question);
  if (docs.length === 0) {
    return {
      answer: `【归纳说明】当前未获取到可打开的飞书云文档链接，暂无法基于飞书正文稳定归纳。请先点击「一键抓取可读文档」后重试。`,
      keyPoints: ["未检出可用飞书文档链接。", "建议先抓取文档并确认授权状态正常。"],
      refs: [],
    };
  }

  const bulletLines: string[] = [];
  const refs: string[] = [];
  for (const doc of docs) {
    const cleaned = stripAttachmentNoise(doc.text || "");
    const picked = [...pickSummaryLines(cleaned, kws, 4), ...extractMetricHighlights(cleaned, metrics)]
      .map((x) => sanitizeSummaryLine(x))
      .filter((x) => {
        const t = x.replace(/\s+/g, " ").trim();
        if (t.length < 14 || t.length > 220) return false;
        if (looksLikeFilenameNoise(t)) return false;
        // 去掉常见「助手提示语/模板句」和重复问句
        if (/^在「.*」场景下/.test(t)) return false;
        if (/请补充型号|打开文档核对|检索了所选来源/.test(t)) return false;
        if (question.length >= 6 && t.includes(question.slice(0, 6))) return false;
        if (!/[A-Za-z\u4e00-\u9fa5]/.test(t)) return false;
        return true;
      })
      .slice(0, 2);
    if (picked.length === 0) continue;
    for (const line of picked) {
      bulletLines.push(`《${doc.title}》：${trimExcerpt(line, 180)}`);
    }
    refs.push(`飞书云文档《${doc.title}》${doc.url ? `（${doc.url}）` : ""}`);
  }

  const finalBullets = dedupeSimilarLines(bulletLines, 6);
  const conclusion = buildMetricConclusion(finalBullets, metrics);
  const answer =
    finalBullets.length > 0
      ? `【归纳说明】下面根据已抓取的飞书云文档正文做摘要（非模型生成，来自检索片段拼接）：\n\n${finalBullets
          .map((x) => `• ${x}`)
          .join("\n")}\n\n【结论】${conclusion}`
      : `【归纳说明】已抓取飞书文档，但当前可提取的正文有效句较少（可能以图片/附件为主）。建议在问题中补充型号或测试项关键词后重试。`;

  return {
    answer,
    keyPoints:
      finalBullets.length > 0
        ? finalBullets.map((x) => trimExcerpt(x, 120)).slice(0, 6)
        : ["当前正文可提取信息较少。", "建议补充更具体关键词并重试。"],
    refs: refs.length > 0 ? refs : docs.map((d) => `飞书云文档《${d.title}》${d.url ? `（${d.url}）` : ""}`),
  };
}

/** 解析引用行中的 URL，渲染为可点击链接 */
function RefLine({ line }: { line: string }) {
  const trimmed = line.trim();
  const urlMatch = trimmed.match(/（(https?:\/\/[^）\s]+)）\s*$/);
  const url = urlMatch?.[1];
  const main = urlMatch ? trimmed.slice(0, urlMatch.index ?? trimmed.length).trim() : trimmed;
  return (
    <li className={styles.refLi}>
      <span>{main}</span>
      {url ? (
        <a className={styles.refLink} href={url} target="_blank" rel="noreferrer">
          打开
        </a>
      ) : null}
    </li>
  );
}

export default function KnowledgeQA() {
  const initialSourceRef = useRef<QASourceStore>();
  if (!initialSourceRef.current) initialSourceRef.current = readQaSourceStore();
  const initialSource = initialSourceRef.current;
  const initialChatRef = useRef<QAChatStore>();
  if (!initialChatRef.current) initialChatRef.current = readQaChatStore();
  const initialChat = initialChatRef.current;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState<TopicId>("flow");
  const [question, setQuestion] = useState("");
  const [sourceMode, setSourceMode] = useState<SourceMode>(initialSource.sourceMode);
  const [selectedSources, setSelectedSources] = useState<SourceId[]>(initialSource.selectedSources);
  const [selectedFolderIds, setSelectedFolderIds] = useState<string[]>(initialSource.selectedFolderIds);
  const [feishuConnected, setFeishuConnected] = useState(initialSource.feishuConnected);
  const bootFeishu = useMemo(() => {
    const cached = readFeishuDocCache();
    if (cached.docs.length > 0) return cached;
    return { docs: initialSource.feishuDocs, lastSyncAt: initialSource.feishuLastSyncAt };
  }, [initialSource.feishuDocs, initialSource.feishuLastSyncAt]);
  const [feishuLastSyncAt, setFeishuLastSyncAt] = useState<number | null>(bootFeishu.lastSyncAt);
  const [feishuDocs, setFeishuDocs] = useState<FeishuDoc[]>(bootFeishu.docs);
  const [feishuDocTextCache, setFeishuDocTextCache] = useState<FeishuDocTextCache>(() => readFeishuTextCache());
  const [docDrawerOpen, setDocDrawerOpen] = useState(false);
  const [docFilter, setDocFilter] = useState("");
  const [syncingFeishu, setSyncingFeishu] = useState(false);
  const [answering, setAnswering] = useState(false);
  const [streamingQuestion, setStreamingQuestion] = useState<string | null>(null);
  const chatThreadRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<QASession[]>(initialChat.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialChat.activeSessionId);
  const [sessionSearch, setSessionSearch] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<QAAttachment[]>([]);
  const [feishuSyncDetail, setFeishuSyncDetail] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const folders = readKnowledgeData().folders;
  const feishuDocCount = feishuDocs.length;
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null,
    [sessions, activeSessionId],
  );
  const visibleSessions = useMemo(() => {
    const q = sessionSearch.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.records.some((r) => r.question.toLowerCase().includes(q) || r.result.answer.toLowerCase().includes(q)),
    );
  }, [sessions, sessionSearch]);
  const visibleFeishuDocs = useMemo(() => {
    const q = docFilter.trim().toLowerCase();
    if (!q) return feishuDocs;
    return feishuDocs.filter((d) => d.title.toLowerCase().includes(q) || d.url.toLowerCase().includes(q));
  }, [feishuDocs, docFilter]);

  const chatTimeline = useMemo(
    () => [...(activeSession?.records ?? [])].reverse(),
    [activeSession?.records],
  );
  const showChatThread = chatTimeline.length > 0 || Boolean(streamingQuestion);

  useFaHistoryRestore(
    "/qa",
    (snap) => {
      if (!isQASnapshot(snap)) return;
      setTopic(snap.topic);
      setQuestion(snap.question);
      if (snap.v === 2) {
        setSourceMode(snap.sourceMode === "single" ? "single" : "multi");
        if (Array.isArray(snap.selectedSources) && snap.selectedSources.length > 0) {
          setSelectedSources(
            snap.selectedSources.filter((x) => x === "internet" || x === "kb_folder" || x === "feishu_drive"),
          );
        }
        if (Array.isArray(snap.selectedFolderIds)) {
          setSelectedFolderIds(snap.selectedFolderIds.filter((x) => typeof x === "string"));
        }
      }
    },
    isQASnapshot,
  );

  useEffect(() => {
    const existing = new Set(folders.map((f) => f.id));
    setSelectedFolderIds((prev) => prev.filter((id) => existing.has(id)));
  }, [folders]);

  useEffect(() => {
    function syncConn() {
      try {
        const t = localStorage.getItem("fa-user-access-token")?.trim() ?? "";
        setFeishuConnected(Boolean(t));
      } catch {
        setFeishuConnected(false);
      }
    }
    syncConn();
    window.addEventListener("fa-user-access-token-updated", syncConn);
    window.addEventListener("storage", syncConn);
    return () => {
      window.removeEventListener("fa-user-access-token-updated", syncConn);
      window.removeEventListener("storage", syncConn);
    };
  }, []);

  useEffect(() => {
    if (!sessions.some((s) => s.id === activeSessionId)) {
      setActiveSessionId(sessions[0]?.id ?? null);
    }
  }, [sessions, activeSessionId]);

  useEffect(() => {
    try {
      const payload: QASourceStore = {
        version: 1,
        sourceMode,
        selectedSources,
        selectedFolderIds,
        feishuConnected,
        feishuLastSyncAt,
        feishuDocs,
      };
      localStorage.setItem(QA_SOURCE_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [sourceMode, selectedSources, selectedFolderIds, feishuConnected, feishuLastSyncAt, feishuDocs]);

  useEffect(() => {
    try {
      localStorage.setItem(
        FEISHU_CACHE_KEY,
        JSON.stringify({ version: 1, lastSyncAt: feishuLastSyncAt, docs: feishuDocs.slice(0, 5000) }),
      );
    } catch {
      // ignore
    }
  }, [feishuDocs, feishuLastSyncAt]);

  useEffect(() => {
    try {
      localStorage.setItem(FEISHU_TEXT_CACHE_KEY, JSON.stringify(feishuDocTextCache));
    } catch {
      // ignore
    }
  }, [feishuDocTextCache]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    try {
      const payload: QAChatStore = {
        version: 2,
        activeSessionId,
        sessions: sessions.map((s) => ({ ...s, records: s.records.slice(0, QA_CHAT_MAX) })),
      };
      localStorage.setItem(QA_CHAT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }, [sessions, activeSessionId]);

  useEffect(() => {
    chatThreadRef.current?.scrollTo({ top: chatThreadRef.current.scrollHeight, behavior: "smooth" });
  }, [activeSession?.records.length, activeSessionId, answering, streamingQuestion]);

  useEffect(() => {
    const q = question.trim();
    if (q.length < 2) return;
    const t = window.setTimeout(() => {
      const label = topics.find((x) => x.id === topic)?.label ?? "知识问答";
      appendWorkbenchHistory({
        path: "/qa",
        moduleLabel: "知识问答",
        title: `草稿 · ${label}：${q.length > 36 ? `${q.slice(0, 36)}…` : q}`,
        snapshot: {
          module: "qa",
          v: 2,
          topic,
          question,
          sourceMode,
          selectedSources,
          selectedFolderIds,
        },
      });
    }, 1800);
    return () => window.clearTimeout(t);
  }, [topic, question, sourceMode, selectedSources, selectedFolderIds]);

  function toggleSource(id: SourceId) {
    setSelectedSources((prev) => {
      if (sourceMode === "single") return [id];
      if (prev.includes(id)) {
        const next = prev.filter((x) => x !== id);
        return next.length ? next : prev;
      }
      return [...prev, id];
    });
  }

  function switchSourceMode(mode: SourceMode) {
    setSourceMode(mode);
    if (mode === "single") {
      setSelectedSources((prev) => [prev[0] ?? "kb_folder"]);
    }
  }

  function toggleFolder(id: string) {
    setSelectedFolderIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function connectFeishu() {
    const t = localStorage.getItem("fa-user-access-token")?.trim() ?? "";
    if (!t) {
      setFeishuConnected(false);
      setNotice({ kind: "error", text: "尚未检测到飞书登录 token，请先点页面顶部“飞书授权/登录”。" });
      return;
    }
    setFeishuConnected(true);
    setNotice({ kind: "success", text: "已检测到飞书登录态，可执行一键抓取。" });
  }

  async function syncFeishuDocs() {
    if (!feishuConnected) {
      setNotice({ kind: "error", text: "请先连接飞书，再执行抓取。" });
      return;
    }
    if (syncingFeishu) return;
    const userAccessToken = localStorage.getItem("fa-user-access-token")?.trim() ?? "";
    if (!userAccessToken) {
      setFeishuSyncDetail({ kind: "error", text: "未检测到 fa-user-access-token。" });
      setNotice({
        kind: "error",
        text: "未检测到飞书用户 token。请先点页面顶部“飞书授权/登录”完成授权，再回来抓取。",
      });
      return;
    }
    setSyncingFeishu(true);
    try {
      const res = await fetch(apiUrl("/api/list-feishu-readable-docs"), {
        method: "POST",
        headers: syncApiHeaders(),
        body: JSON.stringify({
          userAccessToken,
          pageSize: 200,
          maxPages: 15,
        }),
      });
      const rawText = await res.text();
      let data = {} as {
        ok?: boolean;
        docs?: FeishuDoc[];
        total?: number;
        message?: string;
        hint?: string;
        error?: string;
        feishuResponse?: unknown;
        expandWarning?: string;
        mergedSearch?: boolean;
        driveListingCount?: number;
      };
      if (rawText.trim()) {
        try {
          data = JSON.parse(rawText) as typeof data;
        } catch {
          data = { ok: false, message: rawText.slice(0, 220) };
        }
      }
      if (!res.ok || !data?.ok) {
        const detail = `HTTP ${res.status} ${data?.error ?? ""} ${data?.message ?? ""}`.trim();
        setFeishuSyncDetail({ kind: "error", text: detail || "请求失败（返回内容不可解析）" });
        setNotice({
          kind: "error",
          text: `抓取失败：${data?.message || "请检查 sync-server 日志与飞书权限设置。"}`,
        });
        return;
      }
      const nextDocs = Array.isArray(data.docs)
        ? data.docs
            .filter((x) => x && typeof x.id === "string" && typeof x.title === "string")
            .map((x) => ({
              id: x.id,
              title: x.title,
              url: x.url || "",
              updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : Date.now(),
            }))
        : [];
      const now = Date.now();
      setFeishuDocs(nextDocs);
      setFeishuLastSyncAt(now);
      if (nextDocs.length === 0) {
        setFeishuSyncDetail({
          kind: "error",
          text: data?.hint || "接口成功但返回 0 条；通常是账号无读权限、权限未发布或未重新授权。",
        });
        setNotice({
          kind: "error",
          text: data?.hint || "接口可用但未返回文档。请确认该账号在飞书中确有可读文档，并重新授权。",
        });
        return;
      }
      setFeishuSyncDetail(null);
      setNotice({ kind: "success", text: `抓取完成：已同步 ${data.total ?? nextDocs.length} 篇飞书可读文档。` });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFeishuSyncDetail({ kind: "error", text: message });
      setNotice({ kind: "error", text: `抓取失败：${message}` });
    } finally {
      setSyncingFeishu(false);
    }
  }

  async function fetchFeishuDocText(doc: FeishuDoc, userAccessToken: string) {
    const cacheKey = doc.url || doc.id;
    if (feishuDocTextCache[cacheKey]) return feishuDocTextCache[cacheKey];
    if (!doc.url) return "";
    try {
      const res = await fetch(apiUrl("/api/fetch-feishu-doc"), {
        method: "POST",
        headers: syncApiHeaders(),
        body: JSON.stringify({ url: doc.url, userAccessToken }),
      });
      const data = (await res.json()) as { ok?: boolean; text?: string };
      const text = typeof data?.text === "string" ? data.text.trim() : "";
      if (res.ok && data?.ok && text) {
        setFeishuDocTextCache((prev) => ({ ...prev, [cacheKey]: text.slice(0, 200000) }));
        return text;
      }
    } catch {
      // ignore, fallback empty
    }
    return "";
  }

  async function fetchWebSearchEvidence(query: string) {
    try {
      const res = await fetch(apiUrl("/api/web-search-lite"), {
        method: "POST",
        headers: syncApiHeaders(),
        body: JSON.stringify({ query }),
      });
      const data = (await res.json()) as { ok?: boolean; items?: WebSearchItem[] };
      if (!res.ok || !data?.ok || !Array.isArray(data.items)) return [];
      return data.items.slice(0, 5);
    } catch {
      return [];
    }
  }

  async function fetchSearchFeishuDocsForQuery(userAccessToken: string, query: string): Promise<FeishuDoc[]> {
    try {
      const res = await fetch(apiUrl("/api/search-feishu-docs"), {
        method: "POST",
        headers: syncApiHeaders(),
        body: JSON.stringify({ userAccessToken, query: query.slice(0, 50), maxPages: 4 }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        docs?: FeishuDoc[];
      };
      if (!res.ok || !data?.ok || !Array.isArray(data.docs)) return [];
      return data.docs
        .filter((x) => x && typeof x.id === "string" && typeof x.title === "string")
        .map((x) => ({
          id: x.id,
          title: x.title,
          url: typeof x.url === "string" ? x.url : "",
          updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : Date.now(),
        }));
    } catch {
      return [];
    }
  }

  async function buildFeishuCandidatePool(
    q: string,
    userAccessToken: string,
    searchHint?: string,
  ): Promise<FeishuDoc[]> {
    const merged = new Map<string, FeishuDoc>();
    for (const d of feishuDocs) merged.set(d.id, d);
    if (userAccessToken.length >= 10) {
      const hint = (searchHint ?? q).slice(0, 50);
      const found = await fetchSearchFeishuDocsForQuery(userAccessToken, hint);
      for (const d of found) merged.set(d.id, d);
    }
    return [...merged.values()];
  }

  async function submitQuestion() {
    const q = question.trim();
    if (q.length < 2) {
      setNotice({ kind: "error", text: "请先输入问题。" });
      return;
    }
    if (selectedSources.length === 0) {
      setNotice({ kind: "error", text: "请至少选择一种回答来源。" });
      return;
    }
    if (selectedSources.includes("kb_folder") && selectedFolderIds.length === 0) {
      setNotice({ kind: "error", text: "已启用“知识库文件夹”，请至少勾选一个文件夹。" });
      return;
    }
    if (selectedSources.includes("feishu_drive")) {
      const tok = localStorage.getItem("fa-user-access-token")?.trim() ?? "";
      if (!feishuConnected || tok.length < 10) {
        setNotice({
          kind: "error",
          text: "已启用“飞书可读云文档”，请先连接飞书并完成顶部授权（需要 user_access_token）。",
        });
        return;
      }
    }
    const sessionId = activeSession?.id ?? createEmptySession().id;
    const now = Date.now();
    if (!activeSession) {
      const next: QASession = {
        id: sessionId,
        title: q.length > 18 ? `${q.slice(0, 18)}...` : q,
        createdAt: now,
        updatedAt: now,
        records: [],
      };
      setSessions((prev) => [next, ...prev]);
      setActiveSessionId(sessionId);
    }
    const selectedFolderNames = folders
      .filter((f) => selectedFolderIds.includes(f.id))
      .map((f) => f.name);
    const currentKeywords = extractKeywords(q);
    const keywords = mergeKeywordsForRetrieval(q, activeSession?.records ?? []);
    const currentCoreTokens = coreProductTokens(currentKeywords);
    const feishuSearchHint = [q, ...currentKeywords.slice(0, 10)].join(" ").replace(/\s+/g, " ").trim().slice(0, 50);
    setQuestion("");
    setStreamingQuestion(q);
    setAnswering(true);
    try {
      const evidence: Array<{ source: string; title: string; text: string; url?: string }> = [];

      if (selectedSources.includes("kb_folder")) {
        const kbPool = readKnowledgeData().items.filter((it) => selectedFolderIds.includes(it.folderId));
        const learnedMap = await getLearnedTextsForIds(kbPool.map((it) => it.id));
        const kbCandidates = kbPool
          .map((it) => {
            const learned = learnedMap.get(it.id) || "";
            const score = keywords.reduce((a, k) => {
              const kl = k.toLowerCase();
              let s = a;
              if (it.title.toLowerCase().includes(kl)) s += 3;
              if ((it.previewText || "").toLowerCase().includes(kl)) s += 2;
              if (learned.toLowerCase().includes(kl)) s += 2;
              return s;
            }, 0);
            return { ...it, score, learnedBody: learned };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);
        const kbHit = kbCandidates.filter((it) =>
          keywords.some((k) => {
            const kl = k.toLowerCase();
            const body = (it.learnedBody || it.previewText || "").toLowerCase();
            return it.title.toLowerCase().includes(kl) || body.includes(kl);
          }),
        );
        const kbUse = kbHit.length > 0 ? kbHit : kbCandidates;
        for (const it of kbUse.slice(0, 4)) {
          const raw = it.learnedBody || it.previewText || it.title;
          const text = raw.length > 120_000 ? `${raw.slice(0, 120_000)}\n…（已截断）` : raw;
          evidence.push({
            source: "知识库",
            title: it.title,
            text,
            url: it.url,
          });
        }
      }

      if (selectedSources.includes("feishu_drive")) {
        const userAccessToken = localStorage.getItem("fa-user-access-token")?.trim() ?? "";
        const mergedPool = await buildFeishuCandidatePool(q, userAccessToken, feishuSearchHint);
        const onlyFeishuSource = selectedSources.length === 1 && selectedSources[0] === "feishu_drive";
        const rankedTitles = mergedPool
          .map((d) => ({ d, titleScore: scoreTitle(d.title, keywords) }))
          .sort((a, b) => b.titleScore - a.titleScore)
          .slice(0, 22);
        const scored: Array<{ doc: FeishuDoc; titleScore: number; bodyScore: number; text: string }> = [];
        for (let i = 0; i < rankedTitles.length; i += 4) {
          const chunk = rankedTitles.slice(i, i + 4);
          const part = await Promise.all(
            chunk.map(async ({ d, titleScore }) => {
              const text = userAccessToken ? await fetchFeishuDocText(d, userAccessToken) : "";
              const bodyScore = scoreBody(text, keywords);
              return { doc: d, titleScore, bodyScore, text };
            }),
          );
          scored.push(...part);
        }
        scored.sort(
          (a, b) => b.titleScore * 4 + b.bodyScore - (a.titleScore * 4 + a.bodyScore),
        );
        const cores = currentCoreTokens.length > 0 ? currentCoreTokens : coreProductTokens(keywords);
        const THRESH = onlyFeishuSource ? 12 : 28;
        const MIN_HITS = onlyFeishuSource ? 2 : 6;
        let picked = scored
          .filter((x) => {
            if (!matchesCoreProduct(x.doc.title, x.text, cores)) return false;
            const combo = x.titleScore * 4 + x.bodyScore;
            const hits = evidenceKeywordHits(x.doc.title, x.text, keywords);
            return combo >= THRESH && hits >= MIN_HITS;
          })
          .slice(0, 4);
        if (picked.length === 0) {
          picked = scored
            .filter((x) => {
              if (!matchesCoreProduct(x.doc.title, x.text, cores)) return false;
              const combo = x.titleScore * 4 + x.bodyScore;
              const hits = evidenceKeywordHits(x.doc.title, x.text, keywords);
              return combo >= (onlyFeishuSource ? 8 : 22) && hits >= (onlyFeishuSource ? 1 : 5);
            })
            .slice(0, onlyFeishuSource ? 3 : 2);
        }
        if (picked.length === 0 && scored[0]) {
          const x = scored[0];
          const hits = evidenceKeywordHits(x.doc.title, x.text, keywords);
          const coreOk = cores.length === 0 || matchesCoreProduct(x.doc.title, x.text, cores);
          if (coreOk && x.titleScore * 4 + x.bodyScore >= (onlyFeishuSource ? 6 : 16) && hits >= (onlyFeishuSource ? 0 : 4)) {
            picked = [x];
          }
        }
        // 兜底：仅选飞书来源时，至少保留几篇正文可读的文档，避免被严格关键词过滤成空结果
        if (picked.length === 0 && onlyFeishuSource) {
          picked = scored
            .filter((x) => {
              const cleaned = stripAttachmentNoise(x.text || "");
              return cleaned.length >= 60 || (x.doc.title || "").trim().length >= 6;
            })
            .slice(0, 3);
        }
        for (const x of picked) {
          evidence.push({
            source: "飞书云文档",
            title: x.doc.title,
            text: x.text.trim() || x.doc.title,
            url: x.doc.url,
          });
        }
      }

      if (selectedSources.includes("internet")) {
        const web = await fetchWebSearchEvidence(q);
        for (const w of web) {
          evidence.push({ source: "联网", title: w.title || "网页", text: w.snippet || "", url: w.url });
        }
      }

      if (pendingAttachments.length > 0) {
        for (const a of pendingAttachments) {
          evidence.push({
            source: a.kind === "text" ? "附件文本" : "附件图片",
            title: a.name,
            text: a.textPreview || a.name,
          });
        }
      }

      let next = buildSynthesizedAnswer({
        topic,
        question: q,
        evidence,
        dialogContext: "",
        searchKeywords: keywords,
      });
      if (selectedSources.includes("feishu_drive")) {
        const feishuOnly = evidence.filter((e) => e.source === "飞书云文档");
        if (feishuOnly.length > 0) {
          next = buildFeishuDeterministicSummary(q, feishuOnly, currentKeywords.length > 0 ? currentKeywords : keywords);
        }
      }
      const record: QARecord = {
        id: makeId(),
        ts: now,
        topic,
        question: q,
        sources: [...selectedSources],
        folders: selectedFolderNames,
        result: next,
        attachments: pendingAttachments,
      };
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                title: s.records.length === 0 ? (q.length > 18 ? `${q.slice(0, 18)}...` : q) : s.title,
                updatedAt: now,
                records: [record, ...s.records].slice(0, QA_CHAT_MAX),
              }
            : s,
        ),
      );
      setPendingAttachments([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setNotice({
        kind: "success",
        text: `已生成回答（来源：${selectedSources.map((s) => sourceLabel(s)).join(" + ")}）。`,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setNotice({ kind: "error", text: `回答失败：${message}` });
    } finally {
      setStreamingQuestion(null);
      setAnswering(false);
    }
  }

  async function copyLatestAnswer() {
    const latest = activeSession?.records[0] ?? null;
    if (!latest) {
      setNotice({ kind: "error", text: "暂无可复制的回答。" });
      return;
    }
    try {
      await navigator.clipboard.writeText(toAnswerPlainText(latest));
      setNotice({ kind: "success", text: "已复制最新回答到剪贴板。" });
    } catch {
      setNotice({ kind: "error", text: "复制失败，请检查浏览器剪贴板权限。" });
    }
  }

  function exportChatHistory() {
    if (!activeSession || activeSession.records.length === 0) {
      setNotice({ kind: "error", text: "暂无可导出的问答记录。" });
      return;
    }
    const lines: string[] = ["# 知识问答记录导出", ""];
    for (const rec of [...activeSession.records].reverse()) {
      lines.push(`## ${formatTime(rec.ts)} · ${topics.find((t) => t.id === rec.topic)?.label ?? "知识问答"}`);
      lines.push(`- 问题：${rec.question}`);
      lines.push(`- 来源：${rec.sources.map((s) => sourceLabel(s)).join(" + ")}`);
      if (rec.folders.length > 0) lines.push(`- 文件夹：${rec.folders.join("、")}`);
      lines.push("");
      lines.push(rec.result.answer);
      lines.push("");
      if (rec.result.keyPoints.length > 0) {
        lines.push("要点：");
        for (const p of rec.result.keyPoints) lines.push(`- ${p}`);
      }
      if (rec.result.refs.length > 0) {
        lines.push("引用来源：");
        for (const ref of rec.result.refs) lines.push(`- ${ref}`);
      }
      lines.push("");
    }
    const blob = new Blob(["\uFEFF", lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `知识问答记录_${activeSession.title}_${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setNotice({ kind: "success", text: `已导出 ${activeSession.records.length} 条问答记录。` });
  }

  function clearChatHistory() {
    if (!activeSession) return;
    setSessions((prev) => prev.map((s) => (s.id === activeSession.id ? { ...s, records: [] } : s)));
    setNotice({ kind: "info", text: "已清空当前对话记录。" });
  }

  function createSession() {
    const next = createEmptySession();
    setSessions((prev) => [next, ...prev]);
    setActiveSessionId(next.id);
    setQuestion("");
    setPendingAttachments([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeSession(id: string) {
    if (sessions.length <= 1) {
      const only = createEmptySession();
      setSessions([only]);
      setActiveSessionId(only.id);
      return;
    }
    const next = sessions.filter((s) => s.id !== id);
    setSessions(next);
    if (activeSessionId === id) setActiveSessionId(next[0]?.id ?? null);
  }

  async function addAttachments(files: FileList | null) {
    if (!files || files.length === 0) return;
    const next: QAAttachment[] = [];
    for (const file of Array.from(files)) {
      const isText =
        file.type.startsWith("text/") || /\.(txt|md|csv|json|log|xml|yaml|yml|ini|cfg)$/i.test(file.name);
      if (isText) {
        try {
          const text = (await file.text()).replace(/\s+/g, " ").trim();
          next.push({
            id: makeId(),
            name: file.name,
            kind: "text",
            textPreview: text.slice(0, 2400),
          });
        } catch {
          next.push({ id: makeId(), name: file.name, kind: "text" });
        }
      } else {
        next.push({ id: makeId(), name: file.name, kind: "image" });
      }
    }
    setPendingAttachments((prev) => [...prev, ...next].slice(0, 6));
  }

  return (
    <div>
      <h1 className={page.pageTitle}>知识问答</h1>
      <p className={page.pageDesc}>
        可按提问场景选择回答来源：联网、知识库文件夹、飞书可读云文档（可单选或多选），用于统一知识问答。
      </p>
      {notice && (
        <p className={notice.kind === "error" ? page.errorText : page.note} role="status">
          {notice.text}
        </p>
      )}

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

      <div className={styles.qaLayout}>
        <aside className={styles.sessionSidebar} aria-label="问答会话">
          <button type="button" className={`${page.btn} ${page.btnPrimary}`} onClick={createSession}>
            + 新建对话
          </button>
          <input
            className={styles.sessionSearch}
            placeholder="搜索对话"
            value={sessionSearch}
            onChange={(e) => setSessionSearch(e.target.value)}
          />
          <ul className={styles.sessionList}>
            {visibleSessions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={s.id === activeSession?.id ? styles.sessionItemActive : styles.sessionItem}
                  onClick={() => {
                    setActiveSessionId(s.id);
                  }}
                >
                  <span className={styles.sessionTitle}>{s.title}</span>
                  <span className={styles.sessionMeta}>{formatTime(s.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className={styles.sessionDelete}
                  onClick={() => removeSession(s.id)}
                  title="删除对话"
                  aria-label={`删除对话 ${s.title}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <div className={styles.chatMain}>
          <div className={page.panel}>
            <div className={styles.modeRow} role="radiogroup" aria-label="回答来源选择模式">
              <span className={styles.modeLabel}>来源选择：</span>
              <button
                type="button"
                className={sourceMode === "single" ? styles.modeBtnActive : styles.modeBtn}
                onClick={() => switchSourceMode("single")}
              >
                单选
              </button>
              <button
                type="button"
                className={sourceMode === "multi" ? styles.modeBtnActive : styles.modeBtn}
                onClick={() => switchSourceMode("multi")}
              >
                多选
              </button>
            </div>

            <div className={styles.sourceGrid}>
              {sourceOptions.map((src) => {
                const checked = selectedSources.includes(src.id);
                return (
                  <label key={src.id} className={checked ? styles.sourceCardActive : styles.sourceCard}>
                    <input
                      type={sourceMode === "single" ? "radio" : "checkbox"}
                      name="qa-source"
                      checked={checked}
                      onChange={() => toggleSource(src.id)}
                    />
                    <span className={styles.sourceTitle}>{src.label}</span>
                    <span className={styles.sourceDesc}>{src.desc}</span>
                  </label>
                );
              })}
            </div>

            {selectedSources.includes("kb_folder") && (
              <div className={styles.sectionBox}>
                <div className={styles.sectionHead}>
                  <strong>知识库文件夹范围</strong>
                  <button type="button" className={styles.linkTextBtn} onClick={() => setSelectedFolderIds(folders.map((f) => f.id))}>
                    全选
                  </button>
                  <button type="button" className={styles.linkTextBtn} onClick={() => setSelectedFolderIds([])}>
                    清空
                  </button>
                </div>
                {folders.length === 0 ? (
                  <p className={styles.hintText}>未检测到知识库文件夹，请先到“知识库”模块创建分类。</p>
                ) : (
                  <div className={styles.folderChips}>
                    {folders.map((f) => (
                      <label key={f.id} className={selectedFolderIds.includes(f.id) ? styles.chipActive : styles.chip}>
                        <input
                          type="checkbox"
                          checked={selectedFolderIds.includes(f.id)}
                          onChange={() => toggleFolder(f.id)}
                        />
                        {f.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {selectedSources.includes("feishu_drive") && (
              <div className={styles.sectionBox}>
                <div className={styles.sectionHead}>
                  <strong>飞书可读云文档</strong>
                </div>
                <div className={styles.feishuRow}>
                  <button type="button" className={page.btn} onClick={connectFeishu}>
                    {feishuConnected ? "断开飞书连接" : "连接飞书云盘"}
                  </button>
                  <button
                    type="button"
                    className={`${page.btn} ${page.btnPrimary}`}
                    onClick={syncFeishuDocs}
                    disabled={!feishuConnected || syncingFeishu}
                  >
                    {syncingFeishu ? "抓取中..." : "一键抓取可读文档"}
                  </button>
                </div>
                <p className={styles.hintText}>
                  状态：{feishuConnected ? "已连接" : "未连接"}；最近抓取：
                  {feishuLastSyncAt ? formatTime(feishuLastSyncAt) : "未执行"}；文档数：{feishuDocCount}
                </p>
                <div className={styles.attachRow}>
                  <button type="button" className={styles.smallBtn} onClick={() => setDocDrawerOpen((v) => !v)}>
                    {docDrawerOpen ? "收起文档窗口" : "查看抓取文档"}
                  </button>
                </div>
                {feishuSyncDetail?.kind === "error" && (
                  <p className={styles.syncError}>{feishuSyncDetail.text}</p>
                )}
                {docDrawerOpen && (
                  <div className={styles.docDrawer}>
                    <input
                      className={styles.sessionSearch}
                      placeholder="搜索文档标题/链接"
                      value={docFilter}
                      onChange={(e) => setDocFilter(e.target.value)}
                    />
                    <ul className={styles.docList}>
                      {visibleFeishuDocs.slice(0, 200).map((d) => (
                        <li key={d.id} className={styles.docItem}>
                          <a href={d.url || undefined} target="_blank" rel="noreferrer" className={styles.docTitle}>
                            {d.title}
                          </a>
                          <span className={styles.docMeta}>{formatTime(d.updatedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {showChatThread && (
            <div className={styles.chatThreadWrap}>
              <div className={styles.chatThreadHead}>
                <strong>对话</strong>
                <span className={styles.answerMeta}>
                  {activeSession ? `${chatTimeline.length} 轮` : ""} · 来源：
                  {selectedSources.map((s) => sourceLabel(s)).join(" + ")}
                </span>
              </div>
              <div ref={chatThreadRef} className={styles.chatThread} aria-live="polite">
                {chatTimeline.map((rec) => (
                  <div key={rec.id} className={styles.chatTurn}>
                    <div className={styles.msgUser}>
                      <span className={styles.msgBadge}>问</span>
                      <div className={styles.msgBubbleUser}>
                        <p className={styles.msgMeta}>{formatTime(rec.ts)}</p>
                        <p className={styles.msgBody}>{rec.question}</p>
                      </div>
                    </div>
                    <div className={styles.msgAssistant}>
                      <span className={styles.msgBadgeGhost}>答</span>
                      <div className={styles.msgBubbleAssistant}>
                        <p className={styles.msgMeta}>
                          {topics.find((t) => t.id === rec.topic)?.label ?? "知识问答"} ·{" "}
                          {rec.sources.map((s) => sourceLabel(s)).join(" + ")}
                        </p>
                        <p className={styles.answerText}>{rec.result.answer}</p>
                        {rec.result.keyPoints.length > 0 && (
                          <ul className={styles.answerList}>
                            {rec.result.keyPoints.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        )}
                        {rec.result.refs.length > 0 && (
                          <>
                            <p className={styles.answerRefTitle}>引用来源</p>
                            <ul className={styles.answerRefs}>
                              {rec.result.refs.map((x) => (
                                <RefLine key={x} line={x} />
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {streamingQuestion && (
                  <div className={styles.chatTurn}>
                    <div className={styles.msgUser}>
                      <span className={styles.msgBadge}>问</span>
                      <div className={styles.msgBubbleUser}>
                        <p className={styles.msgBody}>{streamingQuestion}</p>
                      </div>
                    </div>
                    <div className={styles.msgAssistant}>
                      <span className={styles.msgBadgeGhost}>答</span>
                      <div className={styles.msgBubbleAssistant}>
                        <p className={styles.hintText}>{answering ? "正在组织回答…" : ""}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
            )}

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
            <div className={styles.attachRow}>
              <input
                ref={fileInputRef}
                type="file"
                className={styles.hiddenInput}
                multiple
                accept="image/*,.txt,.md,.csv,.json,.log,.xml,.yaml,.yml"
                onChange={(e) => void addAttachments(e.target.files)}
              />
              <button type="button" className={styles.smallBtn} onClick={() => fileInputRef.current?.click()}>
                添加图片/文本附件
              </button>
              {pendingAttachments.length > 0 && (
                <span className={styles.answerMeta}>已添加 {pendingAttachments.length} 个附件</span>
              )}
            </div>

            <div className={styles.primaryActionRow}>
              <div className={styles.primaryActionLeft}>
                <button type="button" className={`${page.btn} ${page.btnPrimary}`} onClick={submitQuestion}>
                  发送（按已选来源）
                </button>
                <button
                  type="button"
                  className={page.btn}
                  onClick={() => {
                    setQuestion("");
                    setPendingAttachments([]);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                    setNotice({ kind: "info", text: "已清空输入。上下文对话仍保留。" });
                  }}
                >
                  清空输入
                </button>
              </div>
            </div>

            <div className={styles.historyActions}>
              <button type="button" className={styles.smallBtn} onClick={() => void copyLatestAnswer()}>
                复制最新回答
              </button>
              <button type="button" className={styles.smallBtn} onClick={exportChatHistory}>
                导出当前对话
              </button>
              <button type="button" className={styles.smallBtnGhost} onClick={clearChatHistory}>
                清空当前对话
              </button>
            </div>

            <p className={page.note} style={{ marginTop: "1rem" }}>
              同步文档仍覆盖「云盘遍历」可见的文件；已在服务端合并飞书「文档/wiki
              搜索」结果以纳入更多仅有阅读权限的共享文档（需在开发者后台开通搜索类权限并重新授权）。问答时会再按当前问题做一次站内搜索以提高命中率。
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
