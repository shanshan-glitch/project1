import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useFaHistoryRestore } from "@/hooks/useFaHistoryRestore";
import {
  deleteKnowledgeFileBlob,
  getKnowledgeFileBlob,
  putKnowledgeFileBlob,
} from "@/lib/knowledgeFileBlobDb";
import {
  deleteLearnedText,
  MAX_LEARNED_TEXT_CHARS,
  putLearnedText,
} from "@/lib/knowledgeLearnedTextDb";
import { extractPdfTextFromArrayBuffer } from "@/lib/extractPdfText";
import { apiUrl, syncApiHeaders } from "@/lib/feishuApi";
import { appendWorkbenchHistory } from "@/lib/workbenchHistory";
import page from "./Page.module.css";
import styles from "./KnowledgeBase.module.css";

type SourceType = "local_file" | "web_link" | "feishu_doc";
type LearnStatus = "learning" | "ready" | "failed";

type Folder = {
  id: string;
  name: string;
  description: string;
  createdAt: number;
};

type KnowledgeItem = {
  id: string;
  folderId: string;
  sourceType: SourceType;
  title: string;
  url?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  previewText?: string;
  status: LearnStatus;
  progress: number;
  createdAt: number;
  learningStartedAt?: number;
  learningEtaMs?: number;
  learnedAt?: number;
  errorMessage?: string;
  /** 是否在 IndexedDB 中保存了可预览/下载的本地副本 */
  hasLocalBlob?: boolean;
  /** 是否已抽取正文供知识问答检索（存于独立 IndexedDB） */
  hasLearnedText?: boolean;
  /** 正文抽取 / 远程抓取失败时的说明 */
  learnError?: string;
};

type KnowledgeStateV2 = {
  version: 2;
  folders: Folder[];
  items: KnowledgeItem[];
  selectedFolderId: string | null;
  newFolderName: string;
  sourceInput: string;
  activeSource: SourceType;
};

type KnowledgeHistorySnapshot = {
  module: "knowledge";
  v: 2;
  folders: Folder[];
  items: KnowledgeItem[];
  selectedFolderId: string | null;
  newFolderName: string;
  sourceInput: string;
  activeSource: SourceType;
};

type Notice = { kind: "info" | "success" | "error"; text: string };
type SortField = "title" | "sourceType" | "status" | "createdAt" | "progress";

const STORAGE_KEY = "fa-workbench-knowledge-db-v2";
/** 表格列宽、列显隐等 UI 持久化 */
const UI_STORAGE_KEY = "fa-workbench-knowledge-ui-v1";
/** 知识库操作审计（本地） */
const AUDIT_STORAGE_KEY = "fa-workbench-knowledge-audit-v1";
const AUDIT_MAX = 100;

type DataColKey = "name" | "source" | "status" | "created" | "progress";

type ColumnVisibility = Record<DataColKey, boolean>;

type KnowledgeUiState = {
  version: 1;
  colWidths: Record<DataColKey, number>;
  colVisibility: ColumnVisibility;
};

type KnowledgeAuditEntry = {
  id: string;
  ts: number;
  action: string;
  detail: string;
};

const MAX_PREVIEW_CHARS = 4000;
const MAX_TEXT_READ_BYTES = 1.5 * 1024 * 1024;
/** 单文件副本上限（IndexedDB） */
const MAX_LOCAL_BLOB_BYTES = 50 * 1024 * 1024;
/** 文本预览弹窗最多解码的字节数 */
const MAX_TEXT_MODAL_BYTES = 1.2 * 1024 * 1024;

const DATA_COL_ORDER: DataColKey[] = ["name", "source", "status", "created", "progress"];

const DEFAULT_COL_WIDTHS: Record<DataColKey, number> = {
  name: 280,
  source: 120,
  status: 110,
  created: 160,
  progress: 120,
};

const DEFAULT_COL_VISIBILITY: ColumnVisibility = {
  name: true,
  source: true,
  status: true,
  created: true,
  progress: true,
};

const COL_MIN: Record<DataColKey, number> = {
  name: 160,
  source: 88,
  status: 88,
  created: 120,
  progress: 88,
};

const DEFAULT_FOLDER_TEMPLATES: Array<{ name: string; description: string }> = [
  { name: "失效机理与根因库", description: "器件级失效机理、FA 结论、根因对照" },
  { name: "FA 流程与方法", description: "样品接收、开封、切片、SEM/EDS、报告流程" },
  { name: "测试规范与判定标准", description: "ATE、可靠性、判退标准、客户规范" },
  { name: "案例复盘与纠正措施", description: "典型案例、8D、遏制/长期措施、效果验证" },
  { name: "客户与产品知识", description: "客户背景、应用场景、产品/BOM/批次信息" },
];

function isKnowledgeSnapshot(s: unknown): s is KnowledgeHistorySnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return o.module === "knowledge" && o.v === 2 && Array.isArray(o.folders) && Array.isArray(o.items);
}

function knowledgeSnapshot(p: Omit<KnowledgeHistorySnapshot, "module" | "v">): KnowledgeHistorySnapshot {
  return { module: "knowledge", v: 2, ...p };
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** 统一为字符串，避免 JSON/历史快照里 number 与 string 混用导致勾选与批量移除无法匹配 id */
function normalizeKnowledgeItemId(id: unknown): string {
  return id == null ? "" : String(id);
}

function sanitizeKnowledgeItems(list: unknown): KnowledgeItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it): it is KnowledgeItem => Boolean(it) && typeof it === "object")
    .map((it) => ({
      ...it,
      id: normalizeKnowledgeItemId((it as KnowledgeItem).id),
      folderId: normalizeKnowledgeItemId((it as KnowledgeItem).folderId),
    }))
    .filter((it) => it.id.length > 0 && it.folderId.length > 0);
}

/**
 * 用 IndexedDB 实测结果校准 hasLocalBlob。
 * 解决：localStorage 配额失败导致标志未落盘、旧数据缺字段、与 IDB 不同步等造成的「小文件也无法预览」误报。
 */
async function probeKnowledgeLocalBlobFlags(items: KnowledgeItem[]): Promise<Map<string, boolean>> {
  const local = items.filter((it) => it.sourceType === "local_file");
  const out = new Map<string, boolean>();
  const CONCURRENCY = 12;
  for (let i = 0; i < local.length; i += CONCURRENCY) {
    const slice = local.slice(i, i + CONCURRENCY);
    await Promise.all(
      slice.map(async (it) => {
        const id = normalizeKnowledgeItemId(it.id);
        if (!id) return;
        try {
          const rec = await getKnowledgeFileBlob(id);
          out.set(id, Boolean(rec));
        } catch {
          out.set(id, false);
        }
      }),
    );
  }
  return out;
}

function mergeHasLocalBlobFromProbe(prev: KnowledgeItem[], actual: Map<string, boolean>): KnowledgeItem[] {
  if (actual.size === 0) return prev;
  let changed = false;
  const next = prev.map((it) => {
    if (it.sourceType !== "local_file") return it;
    const id = normalizeKnowledgeItemId(it.id);
    if (!actual.has(id)) return it;
    const want = actual.get(id)!;
    const cur = it.hasLocalBlob === true;
    if (cur === want) return it;
    changed = true;
    return { ...it, hasLocalBlob: want };
  });
  return changed ? next : prev;
}

function deleteKnowledgeAttachmentsForItems(itemList: KnowledgeItem[]) {
  void Promise.all(
    itemList.map(async (it) => {
      const id = normalizeKnowledgeItemId(it.id);
      try {
        if (it.sourceType === "local_file") {
          await deleteKnowledgeFileBlob(id).catch(() => undefined);
        }
        await deleteLearnedText(id).catch(() => undefined);
      } catch {
        /* ignore */
      }
    }),
  );
}

function makeDefaultFolders() {
  const now = Date.now();
  return DEFAULT_FOLDER_TEMPLATES.map((t, idx) => ({
    id: makeId(),
    name: t.name,
    description: t.description,
    createdAt: now - idx,
  }));
}

function buildDefaultState(): KnowledgeStateV2 {
  const folders = makeDefaultFolders();
  return {
    version: 2,
    folders,
    items: [],
    selectedFolderId: folders[0]?.id ?? null,
    newFolderName: "",
    sourceInput: "",
    activeSource: "web_link",
  };
}

function isFeishuUrl(url: string) {
  return /https?:\/\/[^/]*feishu\.cn\//i.test(url);
}

function normalizeUrl(input: string) {
  const raw = input.trim();
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function inferSourceByUrl(url: string, preferred: SourceType): SourceType {
  if (preferred === "feishu_doc") return "feishu_doc";
  if (isFeishuUrl(url)) return "feishu_doc";
  return "web_link";
}

function formatTime(ts: number) {
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

function formatSize(bytes?: number) {
  if (!bytes || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function guessMimeFromName(fileName: string, mime: string | undefined) {
  const m = (mime ?? "").trim();
  if (m && m !== "application/octet-stream") return m;
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".bmp": "image/bmp",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "text/xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".log": "text/plain",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
  };
  return map[ext] ?? (m || "application/octet-stream");
}

function isInlineBrowserPreviewMime(mime: string) {
  return mime === "application/pdf" || mime.startsWith("image/");
}

function isTextModalMime(mime: string, fileName: string) {
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") return true;
  return /\.(txt|md|csv|json|log|xml|yaml|yml|ini|cfg)$/i.test(fileName);
}

function downloadArrayBufferAsFile(name: string, mime: string, data: ArrayBuffer) {
  const blob = new Blob([data], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
}

function readUiState(): KnowledgeUiState {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) {
      return { version: 1, colWidths: { ...DEFAULT_COL_WIDTHS }, colVisibility: { ...DEFAULT_COL_VISIBILITY } };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, colWidths: { ...DEFAULT_COL_WIDTHS }, colVisibility: { ...DEFAULT_COL_VISIBILITY } };
    }
    const o = parsed as Record<string, unknown>;
    const cw = (o.colWidths && typeof o.colWidths === "object" ? o.colWidths : {}) as Record<string, unknown>;
    const cv = (o.colVisibility && typeof o.colVisibility === "object" ? o.colVisibility : {}) as Record<
      string,
      unknown
    >;
    const colWidths: Record<DataColKey, number> = { ...DEFAULT_COL_WIDTHS };
    for (const k of DATA_COL_ORDER) {
      const n = cw[k];
      if (typeof n === "number" && Number.isFinite(n) && n >= COL_MIN[k]) colWidths[k] = Math.round(n);
    }
    const colVisibility: ColumnVisibility = { ...DEFAULT_COL_VISIBILITY };
    for (const k of DATA_COL_ORDER) {
      const b = cv[k];
      if (typeof b === "boolean") colVisibility[k] = b;
    }
    if (!DATA_COL_ORDER.some((k) => colVisibility[k])) {
      colVisibility.name = true;
    }
    return { version: 1, colWidths, colVisibility };
  } catch {
    return { version: 1, colWidths: { ...DEFAULT_COL_WIDTHS }, colVisibility: { ...DEFAULT_COL_VISIBILITY } };
  }
}

function writeUiState(state: KnowledgeUiState) {
  try {
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

function readAuditLog(): KnowledgeAuditEntry[] {
  try {
    const raw = localStorage.getItem(AUDIT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x === "object")
      .map((x) => x as Record<string, unknown>)
      .filter(
        (x) =>
          typeof x.id === "string" &&
          typeof x.ts === "number" &&
          typeof x.action === "string" &&
          typeof x.detail === "string",
      ) as KnowledgeAuditEntry[];
  } catch {
    return [];
  }
}

function writeAuditLog(entries: KnowledgeAuditEntry[]) {
  try {
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(entries.slice(0, AUDIT_MAX)));
  } catch {
    // ignore
  }
}

function escapeCsvCell(value: string) {
  const s = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadTextFile(filename: string, text: string, mime = "text/csv;charset=utf-8") {
  const blob = new Blob(["\uFEFF", text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function readPersistedState(): KnowledgeStateV2 {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return buildDefaultState();
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return buildDefaultState();

    const o = parsed as Record<string, unknown>;
    if (o.version === 2 && Array.isArray(o.folders) && Array.isArray(o.items)) {
      const folders = (o.folders as Folder[]).filter((f) => f && typeof f.id === "string");
      return {
        version: 2,
        folders: folders.length ? folders : makeDefaultFolders(),
        items: sanitizeKnowledgeItems(o.items),
        selectedFolderId:
          typeof o.selectedFolderId === "string" || o.selectedFolderId === null ? o.selectedFolderId : null,
        newFolderName: typeof o.newFolderName === "string" ? o.newFolderName : "",
        sourceInput: typeof o.sourceInput === "string" ? o.sourceInput : "",
        activeSource:
          o.activeSource === "local_file" || o.activeSource === "feishu_doc" || o.activeSource === "web_link"
            ? o.activeSource
            : "web_link",
      };
    }

    // 兼容旧版 v1（仅 folders + entries）
    if (Array.isArray(o.folders) && Array.isArray(o.entries)) {
      const now = Date.now();
      const folders = (o.folders as Array<{ id: string; name: string }>).map((f, idx) => ({
        id: f.id,
        name: f.name,
        description: "从旧版知识库迁移",
        createdAt: now - idx,
      }));
      const items = (o.entries as Array<{ id: string; folderId: string; url: string; addedAt: string }>).map((e) => ({
        id: e.id,
        folderId: e.folderId,
        sourceType: inferSourceByUrl(e.url, "web_link"),
        title: e.url,
        url: e.url,
        status: "ready" as const,
        progress: 100,
        createdAt: now,
        learnedAt: now,
      }));
      return {
        version: 2,
        folders: folders.length ? folders : makeDefaultFolders(),
        items,
        selectedFolderId: typeof o.selectedFolderId === "string" ? o.selectedFolderId : folders[0]?.id ?? null,
        newFolderName: typeof o.newFolderName === "string" ? o.newFolderName : "",
        sourceInput: typeof o.linkUrl === "string" ? o.linkUrl : "",
        activeSource: "web_link",
      };
    }
  } catch {
    // ignore and fallback
  }
  return buildDefaultState();
}

async function readTextPreview(file: File): Promise<string | undefined> {
  const isTextLike =
    file.type.startsWith("text/") ||
    /\.(txt|md|csv|json|log|xml|yaml|yml|ini|cfg)$/i.test(file.name);
  if (!isTextLike) return undefined;
  if (file.size > MAX_TEXT_READ_BYTES) return undefined;
  try {
    const text = await file.text();
    const t = text.trim();
    if (!t) return undefined;
    return t.slice(0, MAX_PREVIEW_CHARS);
  } catch {
    return undefined;
  }
}

function isPdfLike(fileName: string, mime: string | undefined) {
  const m = (mime || "").toLowerCase();
  if (m.includes("pdf")) return true;
  return fileName.toLowerCase().endsWith(".pdf");
}

function isTextLikeFullLearn(fileName: string, mime: string | undefined) {
  if ((mime || "").toLowerCase().startsWith("text/")) return true;
  return /\.(txt|md|csv|json|log|xml|yaml|yml|ini|cfg)$/i.test(fileName);
}

export default function KnowledgeBase() {
  const baseId = useId();
  const initialStateRef = useRef<KnowledgeStateV2>();
  if (!initialStateRef.current) initialStateRef.current = readPersistedState();
  const initial = initialStateRef.current;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [folders, setFolders] = useState<Folder[]>(initial.folders);
  const [items, setItems] = useState<KnowledgeItem[]>(initial.items);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(initial.selectedFolderId);
  const [newFolderName, setNewFolderName] = useState(initial.newFolderName);
  const [sourceInput, setSourceInput] = useState(initial.sourceInput);
  const [activeSource, setActiveSource] = useState<SourceType>(initial.activeSource);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importingFile, setImportingFile] = useState(false);
  const completedToastRef = useRef<Set<string>>(new Set());

  useFaHistoryRestore("/knowledge", (snap) => {
    if (!isKnowledgeSnapshot(snap)) return;
    setFolders(snap.folders);
    const sanitized = sanitizeKnowledgeItems(snap.items);
    setItems(sanitized);
    setSelectedFolderId(snap.selectedFolderId);
    setNewFolderName(snap.newFolderName);
    setSourceInput(snap.sourceInput);
    setActiveSource(snap.activeSource);
    void probeKnowledgeLocalBlobFlags(sanitized)
      .then((actual) => {
        if (actual.size === 0) return;
        setItems((prev) => mergeHasLocalBlobFromProbe(prev, actual));
      })
      .catch(() => undefined);
  }, isKnowledgeSnapshot);

  /** 进入知识库后与 IndexedDB 对齐一次，修复「有副本但列表显示无」的误报 */
  useEffect(() => {
    let cancelled = false;
    const snapshot = itemsRef.current;
    void (async () => {
      const actual = await probeKnowledgeLocalBlobFlags(snapshot);
      if (cancelled || actual.size === 0) return;
      setItems((prev) => mergeHasLocalBlobFromProbe(prev, actual));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedFolder = useMemo(
    () => folders.find((f) => f.id === selectedFolderId) ?? null,
    [folders, selectedFolderId],
  );

  const folderItems = useMemo(
    () => items.filter((e) => e.folderId === selectedFolderId),
    [items, selectedFolderId],
  );

  const learningCount = useMemo(
    () => folderItems.filter((x) => x.status === "learning").length,
    [folderItems],
  );
  const [searchText, setSearchText] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | LearnStatus>("all");
  const [pageSize, setPageSize] = useState(8);
  const [pageIndex, setPageIndex] = useState(1);
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [folderDeletePrompt, setFolderDeletePrompt] = useState<{ id: string; name: string } | null>(null);
  const [folderRename, setFolderRename] = useState<{ id: string; draft: string } | null>(null);
  const [folderRenameNonce, setFolderRenameNonce] = useState(0);
  const folderRenameInputRef = useRef<HTMLInputElement>(null);

  const initialUiRef = useRef<KnowledgeUiState>();
  if (!initialUiRef.current) initialUiRef.current = readUiState();
  const initialUi = initialUiRef.current;
  const [colWidths, setColWidths] = useState<Record<DataColKey, number>>(initialUi.colWidths);
  const [colVisibility, setColVisibility] = useState<ColumnVisibility>(initialUi.colVisibility);
  const [columnPanelOpen, setColumnPanelOpen] = useState(false);
  const [exportPanelOpen, setExportPanelOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<KnowledgeAuditEntry[]>(() => readAuditLog());
  const [textPreviewModal, setTextPreviewModal] = useState<{ title: string; body: string } | null>(null);
  const tableWrapRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{
    left: DataColKey;
    right: DataColKey;
    startX: number;
    wL: number;
    wR: number;
  } | null>(null);

  const appendKnowledgeAudit = useCallback((action: string, detail: string) => {
    const entry: KnowledgeAuditEntry = {
      id: makeId(),
      ts: Date.now(),
      action,
      detail,
    };
    setAuditLogs((prev) => {
      const next = [entry, ...prev].slice(0, AUDIT_MAX);
      writeAuditLog(next);
      return next;
    });
  }, []);

  const visibleDataCols = useMemo(() => {
    const list = DATA_COL_ORDER.filter((k) => colVisibility[k]);
    return list.length ? list : (["name"] as DataColKey[]);
  }, [colVisibility]);

  const gridTemplateColumns = useMemo(() => {
    const parts = ["32px"];
    for (const k of visibleDataCols) {
      parts.push(`${Math.round(colWidths[k])}px`);
    }
    parts.push("minmax(220px, 1fr)");
    return parts.join(" ");
  }, [colWidths, visibleDataCols]);

  const filteredItems = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return folderItems.filter((it) => {
      if (statusFilter !== "all" && it.status !== statusFilter) return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        (it.url ? it.url.toLowerCase().includes(q) : false) ||
        (it.fileName ? it.fileName.toLowerCase().includes(q) : false)
      );
    });
  }, [folderItems, searchText, statusFilter]);

  const sortedItems = useMemo(() => {
    const statusOrder: Record<LearnStatus, number> = { learning: 0, ready: 1, failed: 2 };
    const sourceOrder: Record<SourceType, number> = { feishu_doc: 0, web_link: 1, local_file: 2 };
    const list = [...filteredItems];
    list.sort((a, b) => {
      let cmp = 0;
      if (sortField === "title") cmp = a.title.localeCompare(b.title, "zh-CN");
      if (sortField === "sourceType") cmp = sourceOrder[a.sourceType] - sourceOrder[b.sourceType];
      if (sortField === "status") cmp = statusOrder[a.status] - statusOrder[b.status];
      if (sortField === "createdAt") cmp = a.createdAt - b.createdAt;
      if (sortField === "progress") cmp = a.progress - b.progress;
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [filteredItems, sortField, sortDir]);

  const selectedItemIdSet = useMemo(
    () => new Set(selectedItemIds.map((id) => normalizeKnowledgeItemId(id))),
    [selectedItemIds],
  );
  const pageCount = Math.max(1, Math.ceil(sortedItems.length / pageSize));
  const safePage = Math.min(pageIndex, pageCount);
  const pageItems = useMemo(() => {
    const start = (safePage - 1) * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, safePage, pageSize]);
  const allPageSelected =
    pageItems.length > 0 &&
    pageItems.every((it) => selectedItemIdSet.has(normalizeKnowledgeItemId(it.id)));

  // 本地持久化：刷新、重开网页后仍保留
  useEffect(() => {
    const payload: KnowledgeStateV2 = {
      version: 2,
      folders,
      items,
      selectedFolderId,
      newFolderName,
      sourceInput,
      activeSource,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore quota
    }
  }, [folders, items, selectedFolderId, newFolderName, sourceInput, activeSource]);

  useEffect(() => {
    writeUiState({ version: 1, colWidths, colVisibility });
  }, [colWidths, colVisibility]);

  // 统一推进“学习中”任务，并在完成时弹提示
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      const finishedTitles: string[] = [];
      setItems((prev) => {
        const next = prev.map((it) => {
          if (it.status !== "learning") return it;
          const started = it.learningStartedAt ?? it.createdAt;
          const eta = Math.max(800, it.learningEtaMs ?? 2400);
          const elapsed = now - started;
          const p = Math.min(100, Math.max(3, Math.round((elapsed / eta) * 100)));
          if (p >= 100) {
            changed = true;
            if (!completedToastRef.current.has(it.id)) {
              completedToastRef.current.add(it.id);
              finishedTitles.push(it.title);
            }
            return { ...it, status: "ready" as const, progress: 100, learnedAt: now };
          }
          if (p !== it.progress) {
            changed = true;
            return { ...it, progress: p };
          }
          return it;
        });
        return changed ? next : prev;
      });
      if (finishedTitles.length > 0) {
        setNotice({
          kind: "success",
          text: `学习完成：${finishedTitles.length} 项（${finishedTitles[0]}${finishedTitles.length > 1 ? " 等" : ""}）`,
        });
      }
    }, 450);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    setPageIndex(1);
  }, [selectedFolderId, searchText, statusFilter, pageSize]);

  useEffect(() => {
    if (pageIndex > pageCount) setPageIndex(pageCount);
  }, [pageIndex, pageCount]);

  useEffect(() => {
    // 切换分类时，清空批量选择，避免跨分类误操作
    setSelectedItemIds([]);
  }, [selectedFolderId]);

  useEffect(() => {
    // 条目变化后，清理已不存在的选中项
    setSelectedItemIds((prev) =>
      prev.filter((id) => items.some((it) => normalizeKnowledgeItemId(it.id) === normalizeKnowledgeItemId(id))),
    );
  }, [items]);

  useEffect(() => {
    if (!folderDeletePrompt) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setFolderDeletePrompt(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folderDeletePrompt]);

  useEffect(() => {
    if (!folderRename) return;
    const t = window.requestAnimationFrame(() => {
      folderRenameInputRef.current?.focus();
      folderRenameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(t);
  }, [folderRename?.id, folderRenameNonce]);

  useEffect(() => {
    if (!folderRename) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setFolderRename(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [folderRename?.id]);

  useEffect(() => {
    if (!textPreviewModal) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setTextPreviewModal(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [textPreviewModal]);

  function beginResizeColumn(left: DataColKey, right: DataColKey, clientX: number) {
    resizeDragRef.current = {
      left,
      right,
      startX: clientX,
      wL: colWidths[left],
      wR: colWidths[right],
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: MouseEvent) {
      const drag = resizeDragRef.current;
      if (!drag) return;
      const dx = ev.clientX - drag.startX;
      setColWidths((prev) => {
        const minL = COL_MIN[drag.left];
        const minR = COL_MIN[drag.right];
        let wL = drag.wL + dx;
        let wR = drag.wR - dx;
        if (wL < minL) {
          const d = minL - wL;
          wL = minL;
          wR -= d;
        }
        if (wR < minR) {
          const d = minR - wR;
          wR = minR;
          wL -= d;
        }
        return { ...prev, [drag.left]: Math.round(wL), [drag.right]: Math.round(wR) };
      });
    }
    function onUp() {
      resizeDragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function addFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    if (folders.some((f) => f.name === name)) {
      setNotice({ kind: "error", text: "已存在同名文件夹，请换个名称。" });
      return;
    }
    const id = makeId();
    const nextFolders = [...folders, { id, name, description: "自定义分类", createdAt: Date.now() }];
    setFolders(nextFolders);
    setSelectedFolderId(id);
    setNewFolderName("");
    setNotice({ kind: "success", text: `已创建文件夹：${name}` });
    appendWorkbenchHistory({
      path: "/knowledge",
      moduleLabel: "知识库",
      title: `新建文件夹：${name}`,
      snapshot: knowledgeSnapshot({
        folders: nextFolders,
        items,
        selectedFolderId: id,
        newFolderName: "",
        sourceInput,
        activeSource,
      }),
    });
  }

  function promptRemoveFolder(id: string) {
    const target = folders.find((f) => f.id === id);
    if (!target) return;
    setFolderDeletePrompt({ id: target.id, name: target.name });
  }

  function commitRemoveFolder(id: string) {
    const target = folders.find((f) => f.id === id);
    const nid = normalizeKnowledgeItemId(id);
    const removedItems = items.filter((e) => normalizeKnowledgeItemId(e.folderId) === nid);
    deleteKnowledgeAttachmentsForItems(removedItems);
    setFolders((prev) => prev.filter((f) => normalizeKnowledgeItemId(f.id) !== nid));
    setItems((prev) => prev.filter((e) => normalizeKnowledgeItemId(e.folderId) !== nid));
    setSelectedFolderId((cur) => (normalizeKnowledgeItemId(cur) === nid ? null : cur));
    setNotice({ kind: "info", text: `已删除文件夹${target ? `：${target.name}` : ""}` });
    appendKnowledgeAudit("删除文件夹", `名称：${target?.name ?? id}；已移除其下全部知识项`);
    if (folderRename && normalizeKnowledgeItemId(folderRename.id) === nid) setFolderRename(null);
  }

  function beginRenameFolder(folderId: string) {
    const target = folders.find((f) => f.id === folderId);
    if (!target) return;
    setFolderRename({ id: target.id, draft: target.name });
    setFolderRenameNonce((n) => n + 1);
  }

  function commitRenameFolder() {
    if (!folderRename) return;
    const trimmed = folderRename.draft.trim();
    if (!trimmed) {
      setNotice({ kind: "error", text: "文件夹名称不能为空。" });
      return;
    }
    const { id } = folderRename;
    if (folders.some((f) => f.id !== id && f.name === trimmed)) {
      setNotice({ kind: "error", text: "已存在同名文件夹，请换个名称。" });
      return;
    }
    const old = folders.find((f) => f.id === id);
    if (old && old.name === trimmed) {
      setFolderRename(null);
      return;
    }
    const nextFolders = folders.map((f) => (f.id === id ? { ...f, name: trimmed } : f));
    setFolders(nextFolders);
    setFolderRename(null);
    setNotice({ kind: "success", text: `文件夹已重命名为「${trimmed}」。` });
    appendKnowledgeAudit("重命名文件夹", old ? `「${old.name}」→「${trimmed}」` : `→「${trimmed}」`);
    appendWorkbenchHistory({
      path: "/knowledge",
      moduleLabel: "知识库",
      title: `重命名文件夹：${trimmed}`,
      snapshot: knowledgeSnapshot({
        folders: nextFolders,
        items,
        selectedFolderId,
        newFolderName,
        sourceInput,
        activeSource,
      }),
    });
  }

  function addTemplateFolders() {
    const existing = new Set(folders.map((f) => f.name));
    const missing = DEFAULT_FOLDER_TEMPLATES.filter((t) => !existing.has(t.name));
    if (missing.length === 0) {
      setNotice({ kind: "info", text: "默认分类已全部存在。" });
      return;
    }
    const now = Date.now();
    const created = missing.map((m, idx) => ({
      id: makeId(),
      name: m.name,
      description: m.description,
      createdAt: now - idx,
    }));
    setFolders((prev) => [...prev, ...created]);
    setSelectedFolderId((cur) => cur ?? created[0]?.id ?? null);
    setNotice({ kind: "success", text: `已补充 ${created.length} 个默认分类。` });
  }

  function enqueueLearning(item: KnowledgeItem) {
    const eta = 1800 + Math.floor(Math.random() * 2800);
    return {
      ...item,
      status: "learning" as const,
      progress: 3,
      learningStartedAt: Date.now(),
      learningEtaMs: eta,
    };
  }

  async function learnRemoteKnowledgeItem(item: KnowledgeItem) {
    const id = normalizeKnowledgeItemId(item.id);
    const url = item.url?.trim();
    if (!url) return;
    try {
      let text = "";
      if (item.sourceType === "feishu_doc") {
        const tok = localStorage.getItem("fa-user-access-token")?.trim() ?? "";
        const res = await fetch(apiUrl("/api/fetch-feishu-doc"), {
          method: "POST",
          headers: syncApiHeaders(),
          body: JSON.stringify({ url, userAccessToken: tok.length >= 10 ? tok : undefined }),
        });
        const j = (await res.json()) as { ok?: boolean; text?: string; message?: string };
        if (!res.ok || !j.ok) throw new Error(j.message || `HTTP ${res.status}`);
        text = String(j.text || "");
      } else if (item.sourceType === "web_link") {
        const res = await fetch(apiUrl("/api/fetch-url-text"), {
          method: "POST",
          headers: syncApiHeaders(),
          body: JSON.stringify({ url }),
        });
        const j = (await res.json()) as { ok?: boolean; text?: string; message?: string };
        if (!res.ok || !j.ok) throw new Error(j.message || `HTTP ${res.status}`);
        text = String(j.text || "");
      } else {
        return;
      }
      text = text.replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        await putLearnedText(id, text.slice(0, MAX_LEARNED_TEXT_CHARS));
        setItems((prev) =>
          prev.map((it) =>
            normalizeKnowledgeItemId(it.id) === id ? { ...it, hasLearnedText: true, learnError: undefined } : it,
          ),
        );
        appendKnowledgeAudit("知识库：远程学习完成", item.title);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setItems((prev) =>
        prev.map((it) =>
          normalizeKnowledgeItemId(it.id) === id ? { ...it, hasLearnedText: false, learnError: msg.slice(0, 400) } : it,
        ),
      );
    }
  }

  async function runAttachmentLearnForItem(it: KnowledgeItem) {
    const id = normalizeKnowledgeItemId(it.id);
    try {
      if (it.sourceType === "local_file" && it.hasLocalBlob) {
        const blob = await getKnowledgeFileBlob(id);
        if (!blob) return;
        let learned = "";
        if (isPdfLike(blob.name, blob.mime)) {
          learned = await extractPdfTextFromArrayBuffer(blob.data);
        } else if (isTextLikeFullLearn(blob.name, blob.mime) && blob.data.byteLength <= MAX_TEXT_READ_BYTES) {
          learned = new TextDecoder("utf-8", { fatal: false }).decode(blob.data).trim();
        } else if ((it.previewText || "").trim().length > 0) {
          learned = (it.previewText || "").trim();
        }
        if (learned.length > 0) {
          await putLearnedText(id, learned.slice(0, MAX_LEARNED_TEXT_CHARS));
          setItems((prev) =>
            prev.map((x) =>
              normalizeKnowledgeItemId(x.id) === id ? { ...x, hasLearnedText: true, learnError: undefined } : x,
            ),
          );
          appendKnowledgeAudit("知识库：本地学习完成", it.title);
        }
        return;
      }
      if ((it.sourceType === "feishu_doc" || it.sourceType === "web_link") && it.url) {
        await learnRemoteKnowledgeItem(it);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setItems((prev) =>
        prev.map((x) =>
          normalizeKnowledgeItemId(x.id) === id ? { ...x, learnError: msg.slice(0, 400), hasLearnedText: false } : x,
        ),
      );
    }
  }

  function addLinkToLearn() {
    if (!selectedFolderId || !sourceInput.trim()) return;
    const url = normalizeUrl(sourceInput);
    if (!url) return;
    const sourceType = inferSourceByUrl(url, activeSource);
    const item = enqueueLearning({
      id: makeId(),
      folderId: selectedFolderId,
      sourceType,
      title: url.length > 84 ? `${url.slice(0, 84)}...` : url,
      url,
      status: "learning",
      progress: 0,
      createdAt: Date.now(),
    });
    const nextItems = [...items, item];
    setItems(nextItems);
    setSourceInput("");
    setNotice({ kind: "info", text: "已加入学习队列，正在学习..." });
    appendWorkbenchHistory({
      path: "/knowledge",
      moduleLabel: "知识库",
      title: `添加链接：${url.length > 42 ? `${url.slice(0, 42)}…` : url}`,
      snapshot: knowledgeSnapshot({
        folders,
        items: nextItems,
        selectedFolderId,
        newFolderName,
        sourceInput: "",
        activeSource,
      }),
    });
    void learnRemoteKnowledgeItem(item);
  }

  async function addLocalFiles(files: FileList | null) {
    if (!selectedFolderId || !files || files.length === 0) return;
    setImportingFile(true);
    try {
      const list = Array.from(files);
      const pairs: Array<{ file: File; item: KnowledgeItem }> = [];
      const created: KnowledgeItem[] = [];
      for (const file of list) {
        const previewText = await readTextPreview(file);
        const item = enqueueLearning({
          id: makeId(),
          folderId: selectedFolderId,
          sourceType: "local_file",
          title: file.name,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type || "application/octet-stream",
          previewText,
          status: "learning",
          progress: 0,
          createdAt: Date.now(),
          hasLocalBlob: false,
        });
        pairs.push({ file, item });
        created.push(item);
      }
      if (created.length > 0) {
        const next = [...items, ...created];
        setItems(next);
        setNotice({ kind: "info", text: `已导入 ${created.length} 个本地文件，正在学习...` });
        appendWorkbenchHistory({
          path: "/knowledge",
          moduleLabel: "知识库",
          title: `上传文件：${created.length} 项`,
          snapshot: knowledgeSnapshot({
            folders,
            items: next,
            selectedFolderId,
            newFolderName,
            sourceInput,
            activeSource,
          }),
        });

        const tooBig: string[] = [];
        const storeFailed: string[] = [];
        const okIds = new Set<string>();
        const learnedIds = new Set<string>();
        const maxMb = Math.round(MAX_LOCAL_BLOB_BYTES / (1024 * 1024));
        for (const { file, item } of pairs) {
          if (file.size > MAX_LOCAL_BLOB_BYTES) {
            tooBig.push(file.name);
            continue;
          }
          const id = normalizeKnowledgeItemId(item.id);
          try {
            const data = await file.arrayBuffer();
            await putKnowledgeFileBlob(id, {
              name: file.name,
              mime: file.type || "application/octet-stream",
              data,
            });
            okIds.add(id);
            try {
              let learned = "";
              if (isPdfLike(file.name, file.type)) {
                learned = await extractPdfTextFromArrayBuffer(data);
              } else if (isTextLikeFullLearn(file.name, file.type) && file.size <= MAX_TEXT_READ_BYTES) {
                learned = new TextDecoder("utf-8", { fatal: false }).decode(data).trim();
              } else if ((item.previewText || "").trim().length > 0) {
                learned = (item.previewText || "").trim();
              }
              if (learned.length > 0) {
                await putLearnedText(id, learned.slice(0, MAX_LEARNED_TEXT_CHARS));
                learnedIds.add(id);
              }
            } catch {
              /* 抽取失败不阻断上传 */
            }
          } catch {
            storeFailed.push(file.name);
          }
        }
        if (okIds.size > 0 || learnedIds.size > 0) {
          setItems((prev) =>
            prev.map((it) => {
              const id = normalizeKnowledgeItemId(it.id);
              let next = { ...it };
              if (okIds.has(id)) next = { ...next, hasLocalBlob: true };
              if (learnedIds.has(id)) next = { ...next, hasLearnedText: true, learnError: undefined };
              return next;
            }),
          );
        }
        if (tooBig.length > 0 || storeFailed.length > 0) {
          const names = [...tooBig, ...storeFailed];
          const hint =
            tooBig.length > 0
              ? `${tooBig.length} 个超过 ${maxMb}MB，未保存可预览/下载的副本`
              : `${storeFailed.length} 个保存副本失败`;
          setNotice({
            kind: "error",
            text: `${hint}：${names.slice(0, 3).join("、")}${names.length > 3 ? "…" : ""}`,
          });
        }
      }
    } finally {
      setImportingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function folderNameOf(folderId: string) {
    return folders.find((f) => f.id === folderId)?.name ?? "";
  }

  function statusLabel(st: LearnStatus) {
    if (st === "ready") return "学习完成";
    if (st === "learning") return "学习中";
    return "学习失败";
  }

  function itemToCsvLine(it: KnowledgeItem) {
    const srcText =
      it.sourceType === "local_file" ? "本地文件" : it.sourceType === "feishu_doc" ? "飞书文档" : "网页链接";
    const cols = [
      folderNameOf(it.folderId),
      it.title,
      srcText,
      statusLabel(it.status),
      String(it.progress),
      formatTime(it.createdAt),
      it.url ?? "",
      it.fileName ?? "",
      it.mimeType ?? "",
      it.fileSize != null ? String(it.fileSize) : "",
      (it.previewText ?? "").replace(/\r?\n/g, " ").slice(0, 2000),
      it.errorMessage ?? "",
    ];
    return cols.map((c) => escapeCsvCell(c)).join(",");
  }

  function exportKnowledgeCsv(rows: KnowledgeItem[], label: "filtered" | "selected") {
    if (rows.length === 0) {
      setNotice({ kind: "error", text: "没有可导出的记录。" });
      return;
    }
    const header =
      "文件夹,标题,来源类型,状态,进度,创建时间,URL,文件名,MIME,文件字节,预览摘要,错误信息".split(",").join(",") +
      "\n";
    const body = rows.map((it) => itemToCsvLine(it)).join("\n");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const name =
      label === "filtered"
        ? `知识库_筛选结果_${selectedFolder?.name ?? "未分类"}_${ts}.csv`
        : `知识库_已选_${selectedFolder?.name ?? "未分类"}_${ts}.csv`;
    downloadTextFile(name, header + body);
    appendKnowledgeAudit(
      label === "filtered" ? "导出 CSV（筛选结果）" : "导出 CSV（已选）",
      `分类：${selectedFolder?.name ?? "-"}；条数：${rows.length}`,
    );
    setNotice({ kind: "success", text: `已导出 ${rows.length} 条到 ${name}` });
  }

  function exportFilteredCsv() {
    exportKnowledgeCsv(sortedItems, "filtered");
  }

  function exportSelectedCsv() {
    const set = new Set(selectedItemIds.map((id) => normalizeKnowledgeItemId(id)));
    const rows = sortedItems.filter((it) => set.has(normalizeKnowledgeItemId(it.id)));
    exportKnowledgeCsv(rows, "selected");
  }

  function toggleColVisibility(key: DataColKey) {
    setColVisibility((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      if (!DATA_COL_ORDER.some((k) => next[k])) next.name = true;
      return next;
    });
  }

  function resetColumnLayout() {
    setColWidths({ ...DEFAULT_COL_WIDTHS });
    setColVisibility({ ...DEFAULT_COL_VISIBILITY });
    appendKnowledgeAudit("重置表格列", "列宽与列显隐恢复默认");
  }

  function clearAuditLog() {
    setAuditLogs([]);
    writeAuditLog([]);
    setNotice({ kind: "info", text: "已清空本地操作记录。" });
  }

  function removeItem(id: string) {
    const nid = normalizeKnowledgeItemId(id);
    const target = items.find((x) => normalizeKnowledgeItemId(x.id) === nid);
    if (target?.sourceType === "local_file") {
      void deleteKnowledgeFileBlob(nid).catch(() => undefined);
    }
    void deleteLearnedText(nid).catch(() => undefined);
    setItems((prev) => prev.filter((x) => normalizeKnowledgeItemId(x.id) !== nid));
    setSelectedItemIds((prev) => prev.filter((x) => normalizeKnowledgeItemId(x) !== nid));
    setNotice({ kind: "info", text: `已移除知识项：${target?.title ?? ""}` });
    appendKnowledgeAudit("移除知识项", `标题：${target?.title ?? id}`);
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(field);
    setSortDir(field === "createdAt" ? "desc" : "asc");
  }

  function sortMark(field: SortField) {
    if (sortField !== field) return "↕";
    return sortDir === "asc" ? "↑" : "↓";
  }

  function toggleSelectOne(id: string) {
    const nid = normalizeKnowledgeItemId(id);
    setSelectedItemIds((prev) =>
      prev.some((x) => normalizeKnowledgeItemId(x) === nid)
        ? prev.filter((x) => normalizeKnowledgeItemId(x) !== nid)
        : [...prev, nid],
    );
  }

  function toggleSelectAllOnPage() {
    if (pageItems.length === 0) return;
    const pageIds = pageItems.map((it) => normalizeKnowledgeItemId(it.id));
    if (allPageSelected) {
      setSelectedItemIds((prev) => prev.filter((id) => !pageIds.includes(normalizeKnowledgeItemId(id))));
    } else {
      setSelectedItemIds((prev) => [...new Set([...prev.map(normalizeKnowledgeItemId), ...pageIds])]);
    }
  }

  function selectAllFiltered() {
    const ids = sortedItems.map((it) => normalizeKnowledgeItemId(it.id));
    setSelectedItemIds(ids);
  }

  function clearSelection() {
    setSelectedItemIds([]);
  }

  function reLearnSelected() {
    if (selectedItemIds.length === 0) return;
    const selected = new Set(selectedItemIds.map((id) => normalizeKnowledgeItemId(id)));
    let count = 0;
    const relearnSnapshots: KnowledgeItem[] = [];
    setItems((prev) =>
      prev.map((it) => {
        if (!selected.has(normalizeKnowledgeItemId(it.id))) return it;
        count += 1;
        const next = enqueueLearning({
          ...it,
          learnedAt: undefined,
          errorMessage: undefined,
          hasLearnedText: false,
          learnError: undefined,
        });
        relearnSnapshots.push(next);
        return next;
      }),
    );
    setNotice({ kind: "info", text: `已重新学习 ${count} 项。` });
    appendKnowledgeAudit(
      "批量重学",
      `分类：${selectedFolder?.name ?? "-"}；数量：${count}`,
    );
    setSelectedItemIds([]);
    queueMicrotask(() => {
      for (const snap of relearnSnapshots) {
        void runAttachmentLearnForItem(snap);
      }
    });
  }

  async function previewLocalKnowledgeFile(it: KnowledgeItem) {
    if (it.sourceType !== "local_file") return;
    try {
      const rec = await getKnowledgeFileBlob(normalizeKnowledgeItemId(it.id));
      if (!rec) {
        setNotice({
          kind: "error",
          text: "未找到文件副本。请重新上传该文件，或确认浏览器未禁用 IndexedDB。",
        });
        return;
      }
      const mime = guessMimeFromName(rec.name, rec.mime);
      if (isInlineBrowserPreviewMime(mime)) {
        const blob = new Blob([rec.data], { type: mime });
        const url = URL.createObjectURL(blob);
        const w = window.open(url, "_blank", "noopener,noreferrer");
        if (!w) {
          URL.revokeObjectURL(url);
          setNotice({ kind: "error", text: "浏览器拦截了新窗口，请允许弹窗后重试预览。" });
          return;
        }
        window.setTimeout(() => URL.revokeObjectURL(url), 120_000);
        appendKnowledgeAudit("预览本地文件", it.title);
        return;
      }
      if (isTextModalMime(mime, rec.name)) {
        const slice =
          rec.data.byteLength > MAX_TEXT_MODAL_BYTES ? rec.data.slice(0, MAX_TEXT_MODAL_BYTES) : rec.data;
        const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
        const suffix = rec.data.byteLength > MAX_TEXT_MODAL_BYTES ? "\n\n…（仅展示前部内容）" : "";
        setTextPreviewModal({ title: rec.name, body: text + suffix });
        appendKnowledgeAudit("预览本地文件", it.title);
        return;
      }
      setNotice({ kind: "info", text: "该类型不支持内嵌预览，请使用「下载」查看。" });
    } catch {
      setNotice({ kind: "error", text: "预览失败，请稍后重试。" });
    }
  }

  async function downloadLocalKnowledgeFile(it: KnowledgeItem) {
    if (it.sourceType !== "local_file") return;
    try {
      const rec = await getKnowledgeFileBlob(normalizeKnowledgeItemId(it.id));
      if (!rec) {
        setNotice({
          kind: "error",
          text: "未找到文件副本。请重新上传该文件，或确认浏览器未禁用 IndexedDB。",
        });
        return;
      }
      const mime = guessMimeFromName(rec.name, rec.mime);
      downloadArrayBufferAsFile(rec.name, mime, rec.data);
      appendKnowledgeAudit("下载本地文件", it.title);
    } catch {
      setNotice({ kind: "error", text: "下载失败，请稍后重试。" });
    }
  }

  function removeSelected() {
    if (selectedItemIds.length === 0) return;
    const selected = new Set(selectedItemIds.map((id) => normalizeKnowledgeItemId(id)));
    const count = selected.size;
    const removed = items.filter((it) => selected.has(normalizeKnowledgeItemId(it.id)));
    deleteKnowledgeAttachmentsForItems(removed);
    setItems((prev) => prev.filter((it) => !selected.has(normalizeKnowledgeItemId(it.id))));
    setSelectedItemIds([]);
    setNotice({ kind: "info", text: `已批量移除 ${count} 项。` });
    appendKnowledgeAudit(
      "批量移除",
      `分类：${selectedFolder?.name ?? "-"}；数量：${count}`,
    );
  }

  function sourceBadgeText(sourceType: SourceType) {
    if (sourceType === "local_file") return "本地文件";
    if (sourceType === "feishu_doc") return "飞书文档";
    return "网页链接";
  }

  function columnResizeHandle(left: DataColKey) {
    if (visibleDataCols.length < 2) return null;
    const idx = visibleDataCols.indexOf(left);
    if (idx === -1 || idx >= visibleDataCols.length - 1) return null;
    const right = visibleDataCols[idx + 1];
    return (
      <span
        className={styles.colResize}
        role="separator"
        aria-orientation="vertical"
        title="拖拽调整列宽"
        onMouseDown={(ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          beginResizeColumn(left, right, ev.clientX);
        }}
      />
    );
  }

  return (
    <div>
      <h1 className={page.pageTitle}>知识库</h1>
      <p className={page.pageDesc}>
        支持长期保存本地文件、飞书云文档与网页链接，并在本机持续保留学习结果（刷新或重启后仍可见）。可按芯片失效分析场景建立分类文件夹，持续沉淀知识。
      </p>
      {notice && (
        <p
          className={notice.kind === "error" ? styles.toastError : notice.kind === "success" ? styles.toastOk : styles.toast}
          role="status"
        >
          {notice.text}
        </p>
      )}

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="知识分类">
          <div className={styles.sidebarHead}>
            <span className={styles.sidebarTitle}>文件夹</span>
            <button type="button" className={styles.linkBtn} onClick={addTemplateFolders}>
              补充默认分类
            </button>
          </div>
          <div className={styles.newFolder}>
            <input
              id={`${baseId}-folder-name`}
              className={page.input}
              placeholder="新建文件夹名称（如：封装失效）"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addFolder()}
            />
            <button type="button" className={`${page.btn} ${page.btnPrimary}`} onClick={addFolder}>
              新建
            </button>
          </div>
          {folders.length === 0 ? (
            <p className={styles.emptyHint}>暂无文件夹，请先命名并新建，用于归类不同知识主题。</p>
          ) : (
            <ul className={styles.folderList}>
              {folders.map((f) => (
                <li key={f.id}>
                  {folderRename?.id === f.id ? (
                    <div
                      className={
                        f.id === selectedFolderId
                          ? `${styles.folderRenameEditor} ${styles.folderRenameEditorActive}`
                          : styles.folderRenameEditor
                      }
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span className={styles.folderIcon} aria-hidden>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      <div className={styles.folderRenameInner}>
                        <input
                          ref={folderRenameInputRef}
                          id={`${baseId}-rename-${f.id}`}
                          className={styles.folderRenameInput}
                          value={folderRename.draft}
                          aria-label="文件夹名称"
                          onChange={(e) =>
                            setFolderRename((prev) =>
                              prev && prev.id === f.id ? { ...prev, draft: e.target.value } : prev,
                            )
                          }
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitRenameFolder();
                            }
                          }}
                        />
                        <div className={styles.folderRenameToolbar}>
                          <button type="button" className={styles.folderRenameSave} onClick={commitRenameFolder}>
                            保存
                          </button>
                          <button type="button" className={styles.folderRenameCancel} onClick={() => setFolderRename(null)}>
                            取消
                          </button>
                        </div>
                        <span className={styles.folderDesc}>{f.description}</span>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={
                          f.id === selectedFolderId ? styles.folderRowActive : styles.folderRow
                        }
                        onClick={() => setSelectedFolderId(f.id)}
                      >
                        <span className={styles.folderIcon} aria-hidden>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                            <path
                              d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                              stroke="currentColor"
                              strokeWidth="1.75"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        <span className={styles.folderText}>
                          <span className={styles.folderName}>{f.name}</span>
                          <span className={styles.folderDesc}>{f.description}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className={styles.folderRenameBtn}
                        title="重命名文件夹"
                        aria-label={`重命名文件夹 ${f.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          beginRenameFolder(f.id);
                        }}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                          <path
                            d="M12 20h8M16.5 3.5l4 4L9 19H5v-4L16.5 3.5z"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={styles.folderDelete}
                        title="删除文件夹（需确认）"
                        aria-label={`删除文件夹 ${f.name}，将打开确认对话框`}
                        onClick={(e) => {
                          e.stopPropagation();
                          promptRemoveFolder(f.id);
                        }}
                      >
                        ×
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        <section className={styles.main} aria-label="链接学习">
          {!selectedFolder ? (
            <div className={styles.placeholder}>
              <p className={styles.placeholderTitle}>请选择或新建文件夹</p>
              <p className={styles.placeholderText}>
                分类确定后，即可上传本地文件，或添加飞书链接/网页链接并加入学习队列。
              </p>
            </div>
          ) : (
            <>
              <p className={styles.context}>
                当前分类：<strong>{selectedFolder.name}</strong>
              </p>
              <div className={styles.sourceTabs} role="tablist" aria-label="知识来源">
                <button
                  type="button"
                  className={activeSource === "local_file" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveSource("local_file")}
                >
                  本地文件
                </button>
                <button
                  type="button"
                  className={activeSource === "feishu_doc" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveSource("feishu_doc")}
                >
                  飞书文档/表格
                </button>
                <button
                  type="button"
                  className={activeSource === "web_link" ? styles.tabActive : styles.tab}
                  onClick={() => setActiveSource("web_link")}
                >
                  网页链接
                </button>
              </div>

              {activeSource === "local_file" ? (
                <div className={styles.localUpload}>
                  <p className={styles.smallText}>
                    支持长期保留上传记录。文件二进制副本保存在本机 IndexedDB（单文件约{" "}
                    {Math.round(MAX_LOCAL_BLOB_BYTES / (1024 * 1024))}
                    MB 以内），保存成功后列表会出现「预览」「下载」。文本类另摘取片段便于列表内回看。旧条目若无副本，请删除后重新上传。
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className={styles.hiddenInput}
                    onChange={(e) => void addLocalFiles(e.target.files)}
                  />
                  <button
                    type="button"
                    className={`${page.btn} ${page.btnPrimary}`}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importingFile}
                  >
                    {importingFile ? "处理中..." : "上传本地文件并学习"}
                  </button>
                </div>
              ) : (
                <>
                  <label className={page.label} htmlFor={`${baseId}-url`}>
                    {activeSource === "feishu_doc" ? "飞书云文档 / 表格链接" : "网页链接"}
                  </label>
                  <input
                    id={`${baseId}-url`}
                    className={page.input}
                    type="url"
                    inputMode="url"
                    placeholder={activeSource === "feishu_doc" ? "https://xxx.feishu.cn/docx/..." : "https://..."}
                    value={sourceInput}
                    onChange={(e) => setSourceInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addLinkToLearn()}
                  />
                  <div className={styles.linkActions}>
                    <button
                      type="button"
                      className={`${page.btn} ${page.btnPrimary}`}
                      onClick={addLinkToLearn}
                      disabled={!sourceInput.trim()}
                    >
                      加入并学习
                    </button>
                  </div>
                </>
              )}
              <div className={styles.linkActions}>
                {learningCount > 0 && <span className={styles.learningHint}>正在学习 {learningCount} 项...</span>}
              </div>
              <p className={page.note} style={{ marginTop: "1rem" }}>
                当前版本将知识库持久化到本机浏览器存储。本地 PDF/文本会抽取正文存入 IndexedDB 供「知识问答」检索；飞书/网页链接需本机运行{" "}
                <code style={{ fontSize: "0.85em" }}>npm run dev:all</code>（或已部署的 sync-server）以通过{" "}
                <code style={{ fontSize: "0.85em" }}>/api/fetch-feishu-doc</code>、
                <code style={{ fontSize: "0.85em" }}>/api/fetch-url-text</code> 抓取内容。列表「已学正文」表示抽取成功。
              </p>

              <div className={styles.queue}>
                <div className={styles.queueHeadRow}>
                  <h2 className={styles.queueTitle}>本分类知识项（长期保留）</h2>
                  <div className={styles.manageBar}>
                    <input
                      className={styles.searchInput}
                      placeholder="搜索名称/链接"
                      value={searchText}
                      onChange={(e) => setSearchText(e.target.value)}
                    />
                    <select
                      className={styles.manageSelect}
                      value={statusFilter}
                      onChange={(e) => setStatusFilter(e.target.value as "all" | LearnStatus)}
                    >
                      <option value="all">全部状态</option>
                      <option value="learning">学习中</option>
                      <option value="ready">学习完成</option>
                      <option value="failed">学习失败</option>
                    </select>
                    <select
                      className={styles.manageSelect}
                      value={String(pageSize)}
                      onChange={(e) => setPageSize(Number(e.target.value))}
                    >
                      <option value="8">8 条/页</option>
                      <option value="15">15 条/页</option>
                      <option value="30">30 条/页</option>
                    </select>
                    <button
                      type="button"
                      className={styles.pagerBtn}
                      onClick={() => setColumnPanelOpen((v) => !v)}
                    >
                      列设置
                    </button>
                    <button
                      type="button"
                      className={styles.pagerBtn}
                      onClick={() => setExportPanelOpen((v) => !v)}
                    >
                      导出 / 记录
                    </button>
                  </div>
                </div>
                {selectedItemIds.length > 0 && (
                  <div className={styles.bulkBar}>
                    <span className={styles.queueMeta}>已选 {selectedItemIds.length} 项</span>
                    <div className={styles.bulkActions}>
                      <button type="button" className={styles.pagerBtn} onClick={reLearnSelected}>
                        批量重学
                      </button>
                      <button type="button" className={styles.pagerBtn} onClick={() => removeSelected()}>
                        批量移除
                      </button>
                      <button type="button" className={styles.pagerBtn} onClick={clearSelection}>
                        清空选择
                      </button>
                    </div>
                  </div>
                )}
                {columnPanelOpen && (
                  <div className={styles.columnPanel} role="region" aria-label="表格列设置">
                    <span className={styles.columnPanelTitle}>显示列</span>
                    <label className={styles.colToggle}>
                      <input
                        type="checkbox"
                        checked={colVisibility.name}
                        onChange={() => toggleColVisibility("name")}
                      />
                      名称
                    </label>
                    <label className={styles.colToggle}>
                      <input
                        type="checkbox"
                        checked={colVisibility.source}
                        onChange={() => toggleColVisibility("source")}
                      />
                      来源
                    </label>
                    <label className={styles.colToggle}>
                      <input
                        type="checkbox"
                        checked={colVisibility.status}
                        onChange={() => toggleColVisibility("status")}
                      />
                      状态
                    </label>
                    <label className={styles.colToggle}>
                      <input
                        type="checkbox"
                        checked={colVisibility.created}
                        onChange={() => toggleColVisibility("created")}
                      />
                      创建时间
                    </label>
                    <label className={styles.colToggle}>
                      <input
                        type="checkbox"
                        checked={colVisibility.progress}
                        onChange={() => toggleColVisibility("progress")}
                      />
                      进度
                    </label>
                    <button type="button" className={styles.pagerBtn} onClick={resetColumnLayout}>
                      重置列宽
                    </button>
                    <span className={styles.columnHint}>列宽可在表头分隔线处拖拽调整，设置会保存在本机。</span>
                  </div>
                )}
                {exportPanelOpen && (
                  <div className={styles.exportPanel} role="region" aria-label="导出与操作记录">
                    <div className={styles.exportActions}>
                      <button type="button" className={styles.pagerBtn} onClick={exportFilteredCsv}>
                        导出当前筛选（CSV）
                      </button>
                      <button type="button" className={styles.pagerBtn} onClick={exportSelectedCsv}>
                        导出已选（CSV）
                      </button>
                      <button type="button" className={styles.pagerBtn} onClick={clearAuditLog}>
                        清空操作记录
                      </button>
                    </div>
                    <p className={styles.auditIntro}>
                      以下为本地操作审计（批量重学、批量移除、导出、单项移除等），刷新后仍保留，最多 {AUDIT_MAX}{" "}
                      条。
                    </p>
                    {auditLogs.length === 0 ? (
                      <p className={styles.emptyHint}>暂无操作记录。</p>
                    ) : (
                      <ul className={styles.auditList}>
                        {auditLogs.slice(0, 40).map((log) => (
                          <li key={log.id} className={styles.auditRow}>
                            <span className={styles.auditTime}>{formatTime(log.ts)}</span>
                            <span className={styles.auditAction}>{log.action}</span>
                            <span className={styles.auditDetail}>{log.detail}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {filteredItems.length === 0 ? (
                  <p className={styles.emptyHint} style={{ marginTop: "0.6rem" }}>
                    {folderItems.length === 0 ? "当前分类暂无知识项。" : "没有匹配筛选条件的知识项。"}
                  </p>
                ) : (
                  <>
                    <div className={styles.tableWrap} ref={tableWrapRef}>
                      <div className={styles.tableHeader} style={{ gridTemplateColumns }}>
                        <span className={styles.checkCol}>
                          <input type="checkbox" checked={allPageSelected} onChange={toggleSelectAllOnPage} />
                        </span>
                        {colVisibility.name && (
                          <div className={styles.colHeadCell}>
                            <button type="button" className={styles.sortBtn} onClick={() => toggleSort("title")}>
                              名称 {sortMark("title")}
                            </button>
                            {columnResizeHandle("name")}
                          </div>
                        )}
                        {colVisibility.source && (
                          <div className={styles.colHeadCell}>
                            <button type="button" className={styles.sortBtn} onClick={() => toggleSort("sourceType")}>
                              来源 {sortMark("sourceType")}
                            </button>
                            {columnResizeHandle("source")}
                          </div>
                        )}
                        {colVisibility.status && (
                          <div className={styles.colHeadCell}>
                            <button type="button" className={styles.sortBtn} onClick={() => toggleSort("status")}>
                              状态 {sortMark("status")}
                            </button>
                            {columnResizeHandle("status")}
                          </div>
                        )}
                        {colVisibility.created && (
                          <div className={styles.colHeadCell}>
                            <button type="button" className={styles.sortBtn} onClick={() => toggleSort("createdAt")}>
                              创建时间 {sortMark("createdAt")}
                            </button>
                            {columnResizeHandle("created")}
                          </div>
                        )}
                        {colVisibility.progress && (
                          <div className={styles.colHeadCell}>
                            <button type="button" className={styles.sortBtn} onClick={() => toggleSort("progress")}>
                              进度 {sortMark("progress")}
                            </button>
                          </div>
                        )}
                        <span className={styles.opsHead}>
                          操作
                          <button type="button" className={styles.quickSel} onClick={selectAllFiltered}>
                            全选筛选结果
                          </button>
                        </span>
                      </div>
                      <ul className={styles.tableBody}>
                        {pageItems.map((e) => (
                          <li key={e.id} className={styles.tableRow} style={{ gridTemplateColumns }}>
                            <span className={styles.checkCol}>
                              <input
                                type="checkbox"
                                checked={selectedItemIdSet.has(normalizeKnowledgeItemId(e.id))}
                                onChange={() => toggleSelectOne(e.id)}
                              />
                            </span>
                            {colVisibility.name && (
                              <span className={styles.colName}>
                                {e.url ? (
                                  <a href={e.url} target="_blank" rel="noopener noreferrer" className={styles.queueLink}>
                                    {e.title}
                                  </a>
                                ) : (
                                  <span className={styles.fileTitle}>{e.title}</span>
                                )}
                                <small className={styles.rowMeta}>{e.fileSize ? formatSize(e.fileSize) : ""}</small>
                              </span>
                            )}
                            {colVisibility.source && (
                              <span>
                                <span className={styles.sourceBadge}>{sourceBadgeText(e.sourceType)}</span>
                              </span>
                            )}
                            {colVisibility.status && (
                              <span className={styles.colName}>
                                <span
                                  className={
                                    e.status === "ready"
                                      ? styles.statusReady
                                      : e.status === "learning"
                                        ? styles.statusLearning
                                        : styles.statusFail
                                  }
                                >
                                  {e.status === "ready" ? "学习完成" : e.status === "learning" ? "学习中" : "学习失败"}
                                </span>
                                {e.hasLearnedText ? (
                                  <small className={styles.rowMeta} title="已抽取正文，知识问答可检索">
                                    已学正文
                                  </small>
                                ) : null}
                                {e.learnError && !e.hasLearnedText ? (
                                  <small className={styles.errorText} title={e.learnError}>
                                    {e.learnError.length > 48 ? `${e.learnError.slice(0, 48)}…` : e.learnError}
                                  </small>
                                ) : null}
                              </span>
                            )}
                            {colVisibility.created && (
                              <span className={styles.queueMeta}>{formatTime(e.createdAt)}</span>
                            )}
                            {colVisibility.progress && (
                              <span className={styles.progressCell}>
                                {e.status === "learning" ? (
                                  <div className={styles.progressWrap} aria-label="学习进度">
                                    <div className={styles.progressBar} style={{ width: `${e.progress}%` }} />
                                  </div>
                                ) : (
                                  <span className={styles.queueMeta}>{e.status === "ready" ? "100%" : "-"}</span>
                                )}
                              </span>
                            )}
                            <span className={styles.rowOps}>
                              {e.sourceType === "local_file" && (
                                <>
                                  <button
                                    type="button"
                                    className={styles.entryLinkBtn}
                                    disabled={!e.hasLocalBlob}
                                    title={
                                      e.hasLocalBlob
                                        ? "在新窗口预览"
                                        : "未在浏览器 IndexedDB 中检测到该文件副本（可能从未写入、已清理站点数据、或单文件≥50MB）。可删除后重新上传。"
                                    }
                                    onClick={() => void previewLocalKnowledgeFile(e)}
                                  >
                                    预览
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.entryLinkBtn}
                                    disabled={!e.hasLocalBlob}
                                    title={
                                      e.hasLocalBlob
                                        ? "下载原始文件"
                                        : "未在浏览器 IndexedDB 中检测到该文件副本（可能从未写入、已清理站点数据、或单文件≥50MB）。可删除后重新上传。"
                                    }
                                    onClick={() => void downloadLocalKnowledgeFile(e)}
                                  >
                                    下载
                                  </button>
                                </>
                              )}
                              <button type="button" className={styles.entryDelete} onClick={() => removeItem(e.id)}>
                                移除
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className={styles.pager}>
                      <span className={styles.queueMeta}>
                        共 {filteredItems.length} 条，第 {safePage} / {pageCount} 页
                      </span>
                      <div className={styles.pagerBtns}>
                        <button
                          type="button"
                          className={styles.pagerBtn}
                          disabled={safePage <= 1}
                          onClick={() => setPageIndex((p) => Math.max(1, p - 1))}
                        >
                          上一页
                        </button>
                        <button
                          type="button"
                          className={styles.pagerBtn}
                          disabled={safePage >= pageCount}
                          onClick={() => setPageIndex((p) => Math.min(pageCount, p + 1))}
                        >
                          下一页
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {textPreviewModal && (
        <div
          className={styles.confirmBackdrop}
          role="presentation"
          onClick={() => setTextPreviewModal(null)}
        >
          <div
            className={styles.textPreviewSheet}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${baseId}-tp-title`}
            onClick={(ev) => ev.stopPropagation()}
          >
            <div className={styles.textPreviewHead}>
              <h2 id={`${baseId}-tp-title`} className={styles.textPreviewTitle}>
                {textPreviewModal.title}
              </h2>
              <button type="button" className={styles.textPreviewClose} onClick={() => setTextPreviewModal(null)}>
                关闭
              </button>
            </div>
            <pre className={styles.textPreviewBody}>{textPreviewModal.body}</pre>
          </div>
        </div>
      )}

      {folderDeletePrompt && (
        <div
          className={styles.confirmBackdrop}
          role="presentation"
          onClick={() => setFolderDeletePrompt(null)}
        >
          <div
            className={styles.confirmDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${baseId}-fd-title`}
            aria-describedby={`${baseId}-fd-desc`}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={`${baseId}-fd-title`} className={styles.confirmTitle}>
              删除文件夹
            </h2>
            <p id={`${baseId}-fd-desc`} className={styles.confirmText}>
              确定要删除文件夹「<strong>{folderDeletePrompt.name}</strong>」吗？该文件夹内的所有知识项将一并从本机移除，且
              <strong>无法恢复</strong>。
            </p>
            <div className={styles.confirmActions}>
              <button type="button" className={styles.confirmBtnSecondary} onClick={() => setFolderDeletePrompt(null)}>
                取消
              </button>
              <button
                type="button"
                className={styles.confirmBtnDanger}
                onClick={() => {
                  commitRemoveFolder(folderDeletePrompt.id);
                  setFolderDeletePrompt(null);
                }}
              >
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
