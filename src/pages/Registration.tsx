import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFaHistoryRestore } from "@/hooks/useFaHistoryRestore";
import { apiUrl } from "@/lib/feishuApi";
import { appendWorkbenchHistory } from "@/lib/workbenchHistory";
import page from "./Page.module.css";
import styles from "./Registration.module.css";

type CaseInput = {
  id: string;
  link: string;
  content: string;
};

type Priority = "高" | "中" | "低";

type ExtractedRow = {
  feedbackTime: string;
  contact: string;
  traceCode: string;
  customerInfo: string;
  priority: Priority;
  machineInfo: string;
  chipModel: string;
  failCount: string;
  mileage: string;
  docLink: string;
  failureSymptom: string;
  documentName: string;
  problemSummary: string;
  troubleshootMethod: string;
};

type SyncFeishuDetailSnap = {
  feishu: unknown | null;
  debug: unknown | null;
  errorBodyWasJson: boolean;
  serverMessage?: string;
};

export type RegistrationHistorySnapshot = {
  module: "registration";
  v: 1;
  batchText: string;
  sheetUrl: string;
  syncEndpoint: string;
  autoSync: boolean;
  rows: ExtractedRow[];
  syncStatus: string;
  userAccessToken: string;
  syncFeishuDetail: SyncFeishuDetailSnap | null;
};

function isRegistrationSnapshot(s: unknown): s is RegistrationHistorySnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return o.module === "registration" && o.v === 1 && typeof o.batchText === "string" && Array.isArray(o.rows);
}

function registrationSnapshot(params: {
  batchText: string;
  sheetUrl: string;
  syncEndpoint: string;
  autoSync: boolean;
  rows: ExtractedRow[];
  syncStatus: string;
  userAccessToken: string;
  syncFeishuDetail: SyncFeishuDetailSnap | null;
}): RegistrationHistorySnapshot {
  return { module: "registration", v: 1, ...params };
}

const DEFAULT_SHEET_URL =
  "https://kwh0jtf778.feishu.cn/sheets/shtcnhYhItGKw0mrDVHPTeiHz3S";

function syncHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const k = (import.meta.env.VITE_SYNC_API_KEY ?? "").trim();
  if (k) h["X-Api-Key"] = k;
  return h;
}

/** 本地开发：相对路径走 Vite 代理；线上构建：设置 VITE_FEISHU_API_BASE 指向已部署的 sync-server */
const DEFAULT_SYNC_ENDPOINT = apiUrl("/api/sync-feishu");

const TABLE_HEADERS = [
  "反馈时间",
  "芯片客诉联系人",
  "Trace Code / Lot#",
  "客户信息",
  "优先级",
  "整机信息",
  "芯片型号",
  "失效数量",
  "失效公里数",
  "文档链接",
  "产品失效表现",
] as const;

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const URL_LINE = /^https?:\/\/\S+$/i;
const BLOCK_SEP = /\n(?:-{3,}|={3,}|\*{3,}|_{3,})\n/;

/**
 * 单一粘贴区 → 多 Case：
 * - 多行且每行整行是一条链接 → 每行一 Case；
 * - 或用 --- / === 等分隔块 → 每块一 Case（块首行可为链接，其余为正文）；
 * - 否则整段视为 1 个 Case（自动抽首个 URL 为文档链接，其余为正文）。
 */
function parseBatchInput(raw: string): CaseInput[] {
  const text = normalizeText(raw);
  if (!text) return [];

  const blocks = text.split(BLOCK_SEP).map((b) => b.trim()).filter(Boolean);
  if (blocks.length > 1) {
    return blocks.map((block) => {
      const lines = block.split("\n").map((l) => l.trim());
      const first = lines[0] ?? "";
      if (URL_LINE.test(first)) {
        return { id: makeId(), link: first, content: lines.slice(1).join("\n").trim() };
      }
      const m = block.match(/https?:\/\/[^\s]+/i);
      return { id: makeId(), link: m?.[0] ?? "", content: m ? block.replace(m[0], "").trim() : block };
    });
  }

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1 && lines.every((l) => URL_LINE.test(l))) {
    return lines.map((link) => ({ id: makeId(), link, content: "" }));
  }

  const firstUrl = text.match(/https?:\/\/[^\s]+/i)?.[0] ?? "";
  const rest = firstUrl ? text.replace(firstUrl, "").trim() : text;
  return [{ id: makeId(), link: firstUrl, content: rest }];
}

function formatDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function compressSpaces(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeMultiValue(value: string) {
  const cleaned = compressSpaces(value.replace(/[；]/g, ";").replace(/[，、]/g, ";"));
  const parts = cleaned
    .split(/[;|/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "未提及";
  return [...new Set(parts)].join(";");
}

function extractTitle(fullText: string) {
  const normalized = normalizeText(fullText);
  if (!normalized) return "未命名文档";
  const titleMatch = normalized.match(
    /(?:^|\n)\s*(?:Title|标题)\s*[:：]\s*([^\n]{1,120})/i,
  );
  if (titleMatch?.[1]) return compressSpaces(titleMatch[1]);
  const firstLine = normalized.split("\n").find((line) => line.trim().length > 0) ?? "未命名文档";
  return compressSpaces(firstLine).slice(0, 120);
}

function sectionBetween(fullText: string, startRegex: RegExp, endRegexes: RegExp[]) {
  const text = normalizeText(fullText);
  const startMatch = startRegex.exec(text);
  if (!startMatch || startMatch.index < 0) return "";
  const startIdx = startMatch.index + startMatch[0].length;
  const afterStart = text.slice(startIdx);
  let endIdx = afterStart.length;
  for (const regex of endRegexes) {
    regex.lastIndex = 0;
    const match = regex.exec(afterStart);
    if (match && match.index >= 0) endIdx = Math.min(endIdx, match.index);
  }
  return afterStart.slice(0, endIdx).trim();
}

/**
 * 从飞书 raw_content 等纯文本里取「标签：值」。
 * 兼容行首带序号、Markdown 粗体等（如 **基本信息** 或 1. 联系人：xxx）。
 */
function extractLabeledValue(text: string, labels: string[]) {
  const block = text.replace(/\u200b/g, "");
  for (const label of labels) {
    const pattern = new RegExp(
      `(?:^|\\n)[^\\n]*?(?:${label})\\s*[:：]\\s*([^\\n]+)`,
      "i",
    );
    const match = pattern.exec(block);
    if (match?.[1]) return normalizeMultiValue(match[1]);
  }
  return "未提及";
}

/** 飞书 8D 等：D0 常为「字段 | 值 | 字段 | 值」或 Tab 分列 */
type TableFieldHints = {
  contact?: string;
  traceCode?: string;
  customerInfo?: string;
  machineInfo?: string;
  chipModel?: string;
  failCount?: string;
};

function splitTableLineCells(line: string): string[] {
  const t = line.trim();
  if (t.includes("|") || t.includes("｜")) {
    return t
      .split(/[|｜]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (/\t/.test(t)) return t.split(/\t+/).map((s) => s.trim()).filter((s) => s.length > 0);
  return [];
}

function parseTableRowsToKeyValues(text: string): Record<string, string> {
  const acc: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const parts = splitTableLineCells(line);
    if (parts.length < 2) continue;
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const key = parts[i].replace(/^\*+|\*+$/g, "").replace(/\s+/g, " ").trim();
      const val = parts[i + 1]?.replace(/^\*+|\*+$/g, "").trim() ?? "";
      if (!key || !val) continue;
      acc[key] = val;
    }
  }
  return acc;
}

/** 标签与值分两行：「客户名称」下一行「5」 */
function parseVerticalLabelValueLines(text: string): Record<string, string> {
  const acc: Record<string, string> = {};
  const labels = [
    "客户名称",
    "客诉联系人",
    "终端客户",
    "整机信息",
    "Trace Code/Lot#",
    "禾赛IC#",
    "HSIC-FA#",
  ];
  const lines = text.split(/\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].replace(/^[*#\s]+|[*#\s]+$/g, "").trim();
    const lineClean = line.replace(/[：:]+$/g, "").trim();
    const next = lines[i + 1]?.replace(/^[*#\s]+|[*#\s]+$/g, "").trim() ?? "";
    if (!next || labels.some((L) => next.startsWith(L))) continue;
    for (const lab of labels) {
      if (lineClean === lab || line === lab || line === `${lab}：` || line === `${lab}:`) {
        acc[lab] = next;
        break;
      }
    }
  }
  return acc;
}

/** 与 Excel「客户信息」对应：模板字段「客户名称」的键名可能有空格、星号等 */
function isCustomerNameFieldKey(k: string): boolean {
  const t = k
    .replace(/[\ufeff\u200b]/g, "")
    .replace(/^[*#\s]+|[\*#\s]+$/g, "")
    .replace(/[：:\s]+$/g, "")
    .replace(/\s+/g, "");
  return t === "客户名称";
}

/**
 * 多策略抓取「客户名称」后的值（登记表「客户信息」列）。
 * 兼容：表格导出、无分隔符、紧挨数字等飞书 raw_content 形态。
 */
function extractCustomerNameForInfoColumn(text: string): string | undefined {
  const s = text.replace(/\u200b/g, "").replace(/\r/g, "");
  const kv = { ...parseVerticalLabelValueLines(s), ...parseTableRowsToKeyValues(s) };
  for (const [k, v] of Object.entries(kv)) {
    if (isCustomerNameFieldKey(k) && v.trim()) return normalizeMultiValue(v.trim());
  }
  const patterns: RegExp[] = [
    /客户名称\s*[:：|｜\t]\s*([^\s|\n｜]+)/,
    /客户名称\s+(\S+)/,
    /客户名称\s*\n\s*(\S+)/m,
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m?.[1]) {
      const val = m[1].trim();
      if (val && val !== "客户名称") return normalizeMultiValue(val);
    }
  }
  let from = 0;
  const marker = "客户名称";
  while (from < s.length) {
    const idx = s.indexOf(marker, from);
    if (idx < 0) break;
    const tail = s.slice(idx + marker.length);
    const after = tail.replace(/^[:：|｜\t\s]+/, "");
    const tok = /^([^\s|\n｜]+)/.exec(after);
    if (tok?.[1]) {
      const val = tok[1].trim();
      if (val && val !== marker) return normalizeMultiValue(val);
    }
    from = idx + marker.length;
  }
  return undefined;
}

function map8DTableKv(kv: Record<string, string>): TableFieldHints {
  const hints: TableFieldHints = {};
  for (const [k, v] of Object.entries(kv)) {
    const keyOnly = k.replace(/\s+/g, "");
    if (keyOnly === "客诉联系人" || (/客诉联系人/.test(k) && !/通讯/.test(k))) {
      hints.contact = normalizeMultiValue(v);
    } else if (/Trace\s*Code|Lot#|TraceCode/i.test(k)) {
      hints.traceCode = normalizeMultiValue(v);
    } else if (/整机信息|应用场景|车型/.test(k)) {
      hints.machineInfo = normalizeMultiValue(v);
    } else if (/禾赛\s*IC|芯片型号|芯片料号|HSIC-FA#/i.test(k)) {
      if (!hints.chipModel) hints.chipModel = normalizeMultiValue(v);
    } else if (/失效数量|失效数|How\s*\/\s*How|How\s+much/i.test(k)) {
      const m = /(\d+)\s*pcs?/i.exec(v);
      hints.failCount = m ? m[1] : normalizeMultiValue(v);
    } else if (isCustomerNameFieldKey(k)) {
      /** 登记表「客户信息」= 模板「客户名称」单元格（非客诉号码） */
      hints.customerInfo = normalizeMultiValue(v);
    }
  }
  return hints;
}

/** D0 常见「客户名称｜5」或「客户名称：5」，与 extractLabeledValue 的冒号-only 互补 */
function regexD0ContactCustomerFallbacks(fullText: string): TableFieldHints {
  const hints: TableFieldHints = {};
  const s = fullText.replace(/\u200b/g, "");

  const mContact =
    /客诉联系人\s*[:：|｜]\s*([^|\n｜]+?)(?=\s*[|｜]|\s*联系人通讯|\s*$)/m.exec(s) ||
    /客诉联系人\s+([^\n|｜]+)/m.exec(s);
  if (mContact?.[1]) {
    const v = compressSpaces(mContact[1].trim());
    if (v && !/^通讯信息/i.test(v)) hints.contact = normalizeMultiValue(v);
  }

  const mCustName = /客户名称\s*[:：|｜]\s*([^|\n｜]+)/.exec(s);
  if (mCustName?.[1]) hints.customerInfo = normalizeMultiValue(mCustName[1].trim());

  return hints;
}

function mergeHintStrings(a?: string, b?: string): string | undefined {
  const set = new Set<string>();
  for (const x of [a, b]) {
    if (!x?.trim()) continue;
    for (const p of x.split(";")) {
      const t = p.trim();
      if (t) set.add(t);
    }
  }
  if (set.size === 0) return undefined;
  return [...set].join(";");
}

function firstDefined(...vals: (string | undefined)[]): string | undefined {
  for (const v of vals) {
    if (v != null && String(v).trim() !== "") return v;
  }
  return undefined;
}

/** 全文兜底：表格导出异常时仍尝试抓 Trace / 联系人等 */
function regexTemplateFallbacks(fullText: string): TableFieldHints {
  const hints: TableFieldHints = {};
  const mTrace = /Trace\s*Code\s*\/?\s*Lot#?\s*[:：\s|]*([A-Za-z0-9]+)/i.exec(fullText);
  if (mTrace?.[1]) hints.traceCode = normalizeMultiValue(mTrace[1]);
  const mChip = /禾赛\s*IC#?\s*[:：\s|]*([^\n|]+)/i.exec(fullText);
  if (mChip?.[1]) hints.chipModel = normalizeMultiValue(mChip[1].trim());
  const mMachine = /整机信息\s*[:：\s|]*([^\n|]+)/i.exec(fullText);
  if (mMachine?.[1]) hints.machineInfo = normalizeMultiValue(mMachine[1].trim());
  return hints;
}

/** D2 5W2H：How much 常为 QGD508/1pcs */
function extract5W2HHints(fullText: string): TableFieldHints {
  const hints: TableFieldHints = {};
  const block = sectionBetween(fullText, /(D2\s*Problem|问题描述\s*5W2H|5W2H)/i, [
    /(D3\s|D4\s|临时围堵|Interim|Define\s*Root)/i,
  ]);
  const src = block || fullText;
  const hm = /(?:How\s*\/\s*How\s*much|How\s+much)\s*[:：]\s*([^\n]+)/i.exec(src);
  if (hm?.[1]) {
    const pcs = /(\d+)\s*pcs?/i.exec(hm[1]);
    if (pcs) hints.failCount = pcs[1];
  }
  return hints;
}

function pickField(labeled: string, hint?: string): string {
  if (labeled && labeled !== "未提及") return labeled;
  if (hint && hint.trim()) return normalizeMultiValue(hint);
  return "未提及";
}

function extractMileage(primaryText: string, fallbackText: string) {
  const regex = /(\d+(?:\.\d+)?\s*(?:万?\s*[kK][mM]|公里))/;
  const primary = regex.exec(primaryText);
  if (primary?.[1]) return compressSpaces(primary[1]).replace(/\s+/g, "");
  const fallback = regex.exec(fallbackText);
  if (fallback?.[1]) return compressSpaces(fallback[1]).replace(/\s+/g, "");
  return "未提及";
}

function shortenTo20(value: string) {
  const cleaned = compressSpaces(value).replace(/[。；;，,]+$/g, "");
  return cleaned.length <= 20 ? cleaned : cleaned.slice(0, 20);
}

function extractFailureSymptom(bgSection: string, rootSection: string) {
  const searchText = [bgSection, rootSection].filter(Boolean).join("\n");
  if (!searchText.trim()) return "未提及";

  const electricalPatterns = [
    /(pin\s*\d+\s*(?:漏电|短路|开路|short|open))/i,
    /((?:vdd|vss|vin|vout|treset|gpio\d*|hvdd\d*)\s*(?:漏电|短路|开路|阻抗|偏低|异常|short|open))/i,
    /((?:漏电|短路|开路|short|open).{0,8}(?:pin\s*\d+|vdd|vss|treset|hvdd\d*)?)/i,
    /((?:电流|电压).{0,6}(?:异常|过高|过低))/i,
    /((?:HV|ICT).{0,20}(?:阻值|阻抗|测试).{0,12}(?:异常|偏低|偏高|不合格))/i,
    /(阻值异常|阻抗偏低|HV\s*测试)/i,
  ];
  for (const pattern of electricalPatterns) {
    const match = pattern.exec(searchText);
    if (match?.[1]) return shortenTo20(match[1]);
  }

  const functionPatterns = [/黑屏/, /不启动/, /重启/, /功能异常/, /无法启动/];
  for (const pattern of functionPatterns) {
    const match = pattern.exec(searchText);
    if (match?.[0]) return shortenTo20(match[0]);
  }

  return "未提及";
}

/** 优先级：高=ATX(HT)+OEM/产线规则；低=产线客诉+指定测试场景；中=长城/小米/理想/其他OEM等；默认中 */
function inferPriority(customerInfo: string, machineInfo: string): Priority {
  const raw = `${customerInfo} ${machineInfo}`.replace(/\s+/g, " ");
  if (!raw.trim()) return "中";

  const atxHt =
    /atx\s*[（(]?\s*ht\s*[）)]?/i.test(raw) ||
    /atx\s*（\s*ht\s*）/i.test(raw) ||
    /atx\s*ht\b/i.test(raw);

  if (atxHt && /oem/i.test(raw) && /客诉/.test(raw)) return "高";
  if (/产线/.test(raw) && atxHt && /客诉/.test(raw)) return "高";

  if (
    /产线/.test(raw) &&
    /客诉/.test(raw) &&
    /(整机测试|组装测试|smt\s*测试|smt测试)/.test(raw)
  ) {
    return "低";
  }

  if (
    (/(长城|小米|理想)/.test(raw) && /客诉/.test(raw)) ||
    /其他\s*oem\s*客户\s*客诉/i.test(raw)
  ) {
    return "中";
  }
  if (/oem/i.test(raw) && /客诉/.test(raw)) return "中";

  return "中";
}

function methodBySymptom(symptom: string) {
  const lower = symptom.toLowerCase();
  if (
    /漏电|短路|开路|short|open|电流|电压|pin|vdd|vss|treset/.test(
      lower,
    )
  ) {
    return "电性参数复测+开封定位";
  }
  if (/黑屏|不启动|重启|功能异常|无法启动/.test(lower)) {
    return "系统复现+电性排查";
  }
  return "基础电性筛查";
}

function abnormalRow(link: string): ExtractedRow {
  return {
    feedbackTime: formatDate(new Date()),
    contact: "无法解析",
    traceCode: "无法解析",
    customerInfo: "无法解析",
    priority: "中",
    machineInfo: "无法解析",
    chipModel: "无法解析",
    failCount: "无法解析",
    mileage: "无法解析",
    docLink: link || "原链接",
    failureSymptom: "无法解析",
    documentName: "无法解析",
    problemSummary: "无法解析",
    troubleshootMethod: "基础电性筛查",
  };
}

function extractRow(caseInput: CaseInput): ExtractedRow {
  const content = normalizeText(caseInput.content);
  if (!content) return abnormalRow(caseInput.link.trim());

  const basicSection = sectionBetween(
    content,
    /(D0\s*basic information|basic information|基本信息)/i,
    [/(D1\s|D2\s|失效信息及背景|问题描述)/i, /(define root cause\(s\)|根因分析)/i],
  );
  const backgroundSection = [
    sectionBetween(content, /(失效信息及背景)/i, [/(define root cause\(s\)|根因分析|D4)/i]),
    sectionBetween(content, /(D2\s*Problem|问题描述\s*5W2H|5W2H)/i, [/(D3|D4|临时围堵|Define\s*Root)/i]),
  ]
    .filter(Boolean)
    .join("\n");
  const rootCauseSection = sectionBetween(content, /(define root cause\(s\)|根因分析|D4\s*Define)/i, []);

  const searchBlock = [basicSection, content].find((s) => s && s.trim().length > 0) || content;
  const tableKv = {
    ...parseVerticalLabelValueLines(content),
    ...parseTableRowsToKeyValues(content),
  };
  const hMap = map8DTableKv(tableKv);
  const hD0 = regexD0ContactCustomerFallbacks(content);
  const tableHints: TableFieldHints = {
    ...regexTemplateFallbacks(content),
    ...extract5W2HHints(content),
    ...hMap,
    contact: firstDefined(hMap.contact, hD0.contact),
    customerInfo: mergeHintStrings(
      mergeHintStrings(hMap.customerInfo, hD0.customerInfo),
      extractCustomerNameForInfoColumn(content),
    ),
  };

  const contact = pickField(
    extractLabeledValue(searchBlock, [
      escapeRegExp("芯片客诉联系人"),
      escapeRegExp("客诉联系人"),
      escapeRegExp("联系人"),
      "contact(?: person)?",
    ]),
    tableHints.contact,
  );
  const traceCode = pickField(
    extractLabeledValue(searchBlock, [
      escapeRegExp("Trace Code"),
      "trace\\s*code(?:\\s*/\\s*lot#)?",
      "lot\\s*#",
      "lot\\s*no\\.?",
      escapeRegExp("Trace Code / Lot#"),
    ]),
    tableHints.traceCode,
  );
  const customerInfo = pickField(
    extractLabeledValue(searchBlock, [
      escapeRegExp("客户名称"),
      escapeRegExp("客户信息"),
    ]),
    tableHints.customerInfo,
  );
  const machineInfo = pickField(
    extractLabeledValue(searchBlock, [
      escapeRegExp("整机信息"),
      escapeRegExp("应用场景"),
      escapeRegExp("车型"),
      "vehicle",
      "project",
    ]),
    tableHints.machineInfo,
  );
  const chipModel = pickField(
    extractLabeledValue(searchBlock, [
      escapeRegExp("芯片型号"),
      escapeRegExp("芯片料号"),
      escapeRegExp("禾赛IC#"),
      escapeRegExp("禾赛IC"),
      escapeRegExp("型号"),
      "part\\s*number",
      "\\bpn\\b",
    ]),
    tableHints.chipModel,
  );
  const failCount = pickField(
    extractLabeledValue(searchBlock, [
      escapeRegExp("失效数量"),
      escapeRegExp("失效数"),
      escapeRegExp("数量"),
      "\\bqty\\b",
      "quantity",
    ]),
    tableHints.failCount,
  );
  const title = extractTitle(content);
  const mileage = extractMileage(title, content);
  const failureSymptom = extractFailureSymptom(backgroundSection, rootCauseSection);

  const resolvedPriority = inferPriority(customerInfo, machineInfo);

  return {
    feedbackTime: formatDate(new Date()),
    contact,
    traceCode,
    customerInfo,
    priority: resolvedPriority,
    machineInfo,
    chipModel,
    failCount,
    mileage,
    docLink: caseInput.link.trim() || "原链接",
    failureSymptom,
    documentName: title,
    problemSummary: failureSymptom,
    troubleshootMethod: methodBySymptom(failureSymptom),
  };
}

function rowToTsv(row: ExtractedRow) {
  return [
    row.feedbackTime,
    row.contact,
    row.traceCode,
    row.customerInfo,
    row.priority,
    row.machineInfo,
    row.chipModel,
    row.failCount,
    row.mileage,
    row.docLink,
    row.failureSymptom,
  ].join("\t");
}

function csvEscapeCell(value: string) {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowToCsv(row: ExtractedRow) {
  return [
    row.feedbackTime,
    row.contact,
    row.traceCode,
    row.customerInfo,
    row.priority,
    row.machineInfo,
    row.chipModel,
    row.failCount,
    row.mileage,
    row.docLink,
    row.failureSymptom,
  ]
    .map(csvEscapeCell)
    .join(",");
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isFeishuDocxUrl(url: string): boolean {
  return /\/docx\/[a-zA-Z0-9]+/.test(url.trim());
}

type FetchDocBody = { ok?: boolean; text?: string; message?: string; error?: string };

/**
 * 拉取文档正文：飞书 docx 必须走本机/部署的 sync-server（/api/fetch-feishu-doc）；浏览器无法直接读飞书页面。
 */
async function fetchDocumentFromUrl(
  url: string,
  opts?: { userAccessToken?: string },
): Promise<{ text: string; error?: string }> {
  const trimmed = url.trim();
  if (!trimmed) return { text: "" };
  if (isFeishuDocxUrl(trimmed)) {
    try {
      const res = await fetch(apiUrl("/api/fetch-feishu-doc"), {
        method: "POST",
        headers: syncHeaders(),
        body: JSON.stringify({ url: trimmed, userAccessToken: opts?.userAccessToken?.trim() || undefined }),
      });
      let data: FetchDocBody = {};
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        data = (await res.json()) as FetchDocBody;
      } else {
        await res.text();
      }
      if (res.ok && data.ok === true && typeof data.text === "string" && data.text.trim().length > 0) {
        return { text: data.text };
      }
      const apiMsg = typeof data.message === "string" ? data.message : "";
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        return {
          text: "",
          error:
            "连不上本地同步服务（端口 3789）。请在项目目录执行 npm.cmd run dev:all（或另开终端运行 npm.cmd run sync-server），保持进程不关，再点「一键抽取」。",
        };
      }
      if (!res.ok) {
        return {
          text: "",
          error: apiMsg || `拉取云文档失败（HTTP ${res.status}）。`,
        };
      }
      return {
        text: "",
        error:
          apiMsg ||
          "飞书未返回可用正文。可优先填写「用户访问令牌（user_access_token）」；若未填写，则检查应用权限、文档授权及 .env 中 App ID/Secret。",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        text: "",
        error: `无法请求同步服务：${msg}。请先运行 npm.cmd run dev:all 或 npm.cmd run sync-server，并确认「同步服务地址」为 ${apiUrl("/api/sync-feishu")}（开发环境一般为 /api/... 由 Vite 代理）。`,
      };
    }
  }
  try {
    const res = await fetch(trimmed, {
      method: "GET",
      mode: "cors",
      credentials: "omit",
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8" },
    });
    if (!res.ok) return { text: "" };
    return { text: await res.text() };
  } catch {
    return {
      text: "",
      error: "浏览器无法跨域读取该链接，请将文档全文粘贴到输入框（或用飞书 docx 链接并启动 sync-server）。",
    };
  }
}

/** 飞书 v2 写入：带显示文本的超链接（表格里显示文档名，点击仍打开链接） */
type FeishuUrlCell = { type: "url"; text: string; link: string };

function docLinkForFeishuSync(row: ExtractedRow): string | FeishuUrlCell {
  const link = row.docLink.trim();
  if (!link || link === "原链接") return link || "原链接";
  if (!/^https?:\/\//i.test(link)) return link;
  let text = row.documentName?.trim() ?? "";
  if (!text || text === "无法解析") text = "云文档";
  return { type: "url", text, link };
}

function buildSyncPayload(sheetUrlValue: string, extracted: ExtractedRow[]) {
  return {
    sheetUrl: sheetUrlValue,
    sheetName: "HESAI FA Tracking Sheet V1.0",
    headers: TABLE_HEADERS,
    rows: extracted.map((row) => ({
      反馈时间: row.feedbackTime,
      芯片客诉联系人: row.contact,
      "Trace Code / Lot#": row.traceCode,
      客户信息: row.customerInfo,
      优先级: row.priority,
      整机信息: row.machineInfo,
      芯片型号: row.chipModel,
      失效数量: row.failCount,
      失效公里数: row.mileage,
      文档链接: docLinkForFeishuSync(row),
      产品失效表现: row.failureSymptom,
    })),
  };
}

export default function Registration() {
  const [batchText, setBatchText] = useState("");
  const [sheetUrl, setSheetUrl] = useState(DEFAULT_SHEET_URL);
  const [syncEndpoint, setSyncEndpoint] = useState(DEFAULT_SYNC_ENDPOINT);
  const [autoSync, setAutoSync] = useState(true);
  const [rows, setRows] = useState<ExtractedRow[]>([]);
  const [syncStatus, setSyncStatus] = useState("");
  const [userAccessToken, setUserAccessToken] = useState(() => {
    if (typeof window === "undefined") return "";
    return window.localStorage.getItem("fa-user-access-token") ?? "";
  });
  /** 同步失败时展示（区域在按钮正下方、「抽取结果」表格上方） */
  const [syncFeishuDetail, setSyncFeishuDetail] = useState<{
    feishu: unknown | null;
    debug: unknown | null;
    /** 整段响应体是否解析为 JSON（与「feishu/debug 为 null」不是一回事） */
    errorBodyWasJson: boolean;
    /** 解析自 JSON 的 message，便于在面板内单独复制 */
    serverMessage?: string;
  } | null>(null);
  const feishuErrorPanelRef = useRef<HTMLDivElement>(null);
  const [extracting, setExtracting] = useState(false);
  const syncFeishuDetailRef = useRef(syncFeishuDetail);
  syncFeishuDetailRef.current = syncFeishuDetail;

  useFaHistoryRestore("/registration", (snap) => {
    if (!isRegistrationSnapshot(snap)) return;
    setBatchText(snap.batchText);
    setSheetUrl(snap.sheetUrl);
    setSyncEndpoint(snap.syncEndpoint);
    setAutoSync(snap.autoSync);
    setRows(snap.rows);
    setSyncStatus(snap.syncStatus);
    setUserAccessToken(snap.userAccessToken);
    setSyncFeishuDetail(snap.syncFeishuDetail);
  }, isRegistrationSnapshot);

  const parsedCount = useMemo(() => {
    return parseBatchInput(batchText).filter((c) => c.link.trim() || c.content.trim()).length;
  }, [batchText]);

  useLayoutEffect(() => {
    if (syncFeishuDetail == null) return;
    feishuErrorPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [syncFeishuDetail]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (userAccessToken.trim()) {
      window.localStorage.setItem("fa-user-access-token", userAccessToken.trim());
    } else {
      window.localStorage.removeItem("fa-user-access-token");
    }
  }, [userAccessToken]);

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const data = ev.data as { source?: string; ok?: boolean; access_token?: string; refresh_token?: string };
      if (!data || data.source !== "feishu-oauth") return;
      if (data.ok && typeof data.access_token === "string" && data.access_token.trim()) {
        setUserAccessToken(data.access_token.trim());
        if (typeof data.refresh_token === "string" && data.refresh_token.trim()) {
          window.localStorage.setItem("fa-feishu-refresh-token", data.refresh_token.trim());
        }
        setSyncStatus("已从飞书授权获取用户令牌，可重新抽取文档。");
      } else {
        setSyncStatus("飞书授权未完成或失败，请关闭飞书授权标签页后重试，或改用手动粘贴令牌。");
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  /** 从页顶「飞书登录」完成 OAuth 时已写入 localStorage，此处同步到受控输入框 */
  useEffect(() => {
    function syncTokenFromStorage() {
      try {
        const t = window.localStorage.getItem("fa-user-access-token") ?? "";
        setUserAccessToken(t);
      } catch {
        /* ignore */
      }
    }
    window.addEventListener("fa-user-access-token-updated", syncTokenFromStorage);
    return () => window.removeEventListener("fa-user-access-token-updated", syncTokenFromStorage);
  }, []);

  async function resolveCasesContent(activeCases: CaseInput[]) {
    let fetchFailCount = 0;
    const fetchHints: string[] = [];
    const resolved: CaseInput[] = [];
    for (const c of activeCases) {
      let content = normalizeText(c.content);
      if (!content && c.link.trim()) {
        const { text, error } = await fetchDocumentFromUrl(c.link.trim(), {
          userAccessToken,
        });
        content = normalizeText(text);
        if (!content) {
          fetchFailCount += 1;
          if (error && !fetchHints.includes(error)) fetchHints.push(error);
        }
      }
      resolved.push({ ...c, content });
    }
    return { resolved, fetchFailCount, fetchHints };
  }

  type SyncSheetResult = {
    ok: boolean;
    message: string;
    feishuResponse?: unknown | null;
    debug?: unknown | null;
    errorBodyWasJson?: boolean;
    serverMessage?: string;
  };

  async function syncToSheetWithRows(extracted: ExtractedRow[]): Promise<SyncSheetResult> {
    const payload = buildSyncPayload(sheetUrl, extracted);
    if (!syncEndpoint.trim()) {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      return { ok: false, message: "未配置同步地址，已复制 JSON Payload。" };
    }
    try {
      const response = await fetch(syncEndpoint, {
        method: "POST",
        headers: syncHeaders(),
        body: JSON.stringify(payload),
      });
      const rawText = await response.text();
      let data = {} as {
        ok?: boolean;
        message?: string;
        appended?: number;
        error?: string;
        feishuResponse?: unknown | null;
        debug?: unknown | null;
      };
      let errorBodyWasJson = false;
      if (rawText.trim()) {
        try {
          data = JSON.parse(rawText) as typeof data;
          errorBodyWasJson = true;
        } catch {
          data = {};
        }
      }
      const serverMessage = typeof data.message === "string" ? data.message : undefined;
      if (!response.ok) {
        return {
          ok: false,
          message: `同步失败：HTTP ${response.status} ${data.message ?? ""}（详情见紧挨按钮下方的「飞书接口返回」区域，在「抽取结果」表格上方）`,
          feishuResponse: data.feishuResponse,
          debug: data.debug,
          errorBodyWasJson,
          serverMessage,
        };
      }
      if (data.ok === false) {
        return {
          ok: false,
          message: `同步失败：${data.message ?? "未知错误"}（详情见紧挨按钮下方的「飞书接口返回」区域，在「抽取结果」表格上方）`,
          feishuResponse: data.feishuResponse,
          debug: data.debug,
          errorBodyWasJson,
          serverMessage,
        };
      }
      return {
        ok: true,
        message: `已写入飞书 ${data.appended ?? extracted.length} 行。`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      return {
        ok: false,
        message: `同步失败：${message}（请确认已部署并运行飞书同步服务，或本地执行 npm.cmd run dev:all / npm.cmd run sync-server）`,
      };
    }
  }

  function applySyncResult(r: SyncSheetResult) {
    setSyncStatus(r.message);
    if (!r.ok) {
      setSyncFeishuDetail({
        feishu: r.feishuResponse !== undefined ? r.feishuResponse : null,
        debug: r.debug !== undefined ? r.debug : null,
        errorBodyWasJson: r.errorBodyWasJson ?? false,
        serverMessage: r.serverMessage,
      });
    } else {
      setSyncFeishuDetail(null);
    }
  }

  async function runExtractAndSync() {
    const activeCases = parseBatchInput(batchText).filter((c) => c.link.trim() || c.content.trim());
    if (activeCases.length === 0) {
      setSyncStatus("请在上方粘贴：多行链接、或用 --- 分隔的多段文档。");
      setRows([]);
      return;
    }

    setExtracting(true);
    setSyncStatus("正在拉取链接并抽取…");
    setSyncFeishuDetail(null);
    setRows([]);
    let capturedDetail: SyncFeishuDetailSnap | null = null;
    try {
      const { resolved, fetchFailCount, fetchHints } = await resolveCasesContent(activeCases);
      const extracted = resolved.map(extractRow);
      setRows(extracted);

      let msg = `已识别 ${activeCases.length} 个 Case，完成抽取 ${extracted.length} 行。`;
      if (fetchFailCount > 0) {
        msg += ` 其中 ${fetchFailCount} 个链接未拉到正文。`;
        if (fetchHints.length > 0) {
          msg += ` 原因：${fetchHints.join(" ")}`;
        } else {
          msg += ` 可将文档全文粘贴到输入框再试。`;
        }
      }
      if (autoSync) {
        const syncResult = await syncToSheetWithRows(extracted);
        msg += ` ${syncResult.message}`;
        if (!syncResult.ok) {
          const d: SyncFeishuDetailSnap = {
            feishu: syncResult.feishuResponse !== undefined ? syncResult.feishuResponse : null,
            debug: syncResult.debug !== undefined ? syncResult.debug : null,
            errorBodyWasJson: syncResult.errorBodyWasJson ?? false,
            serverMessage: syncResult.serverMessage,
          };
          setSyncFeishuDetail(d);
          capturedDetail = d;
        } else {
          setSyncFeishuDetail(null);
          capturedDetail = null;
        }
      } else {
        setSyncFeishuDetail(null);
        capturedDetail = null;
      }
      setSyncStatus(msg);
      appendWorkbenchHistory({
        path: "/registration",
        moduleLabel: "信息登记",
        title: msg.length > 56 ? `${msg.slice(0, 56)}…` : msg,
        snapshot: registrationSnapshot({
          batchText,
          sheetUrl,
          syncEndpoint,
          autoSync,
          rows: extracted,
          syncStatus: msg,
          userAccessToken,
          syncFeishuDetail: capturedDetail,
        }),
      });
    } finally {
      setExtracting(false);
    }
  }

  async function runExtractionOnly() {
    const activeCases = parseBatchInput(batchText).filter((c) => c.link.trim() || c.content.trim());
    if (activeCases.length === 0) {
      setSyncStatus("请先粘贴内容。");
      setRows([]);
      return;
    }
    setExtracting(true);
    setSyncStatus("正在抽取…");
    try {
      const { resolved, fetchFailCount, fetchHints } = await resolveCasesContent(activeCases);
      const extracted = resolved.map(extractRow);
      setRows(extracted);
      let msg = `完成 ${extracted.length} 行抽取。`;
      if (fetchFailCount > 0) {
        msg += `（${fetchFailCount} 个链接未拉到正文）`;
        if (fetchHints.length > 0) msg += ` ${fetchHints.join(" ")}`;
      }
      setSyncStatus(msg);
      appendWorkbenchHistory({
        path: "/registration",
        moduleLabel: "信息登记",
        title: msg.length > 56 ? `${msg.slice(0, 56)}…` : msg,
        snapshot: registrationSnapshot({
          batchText,
          sheetUrl,
          syncEndpoint,
          autoSync,
          rows: extracted,
          syncStatus: msg,
          userAccessToken,
          syncFeishuDetail: syncFeishuDetailRef.current,
        }),
      });
    } finally {
      setExtracting(false);
    }
  }

  async function copyAsTsv() {
    if (rows.length === 0) return;
    const tsv = [TABLE_HEADERS.join("\t"), ...rows.map(rowToTsv)].join("\n");
    await navigator.clipboard.writeText(tsv);
    setSyncStatus("已复制横表（TSV）。");
  }

  function downloadCsvForExcel() {
    if (rows.length === 0) return;
    const headerLine = TABLE_HEADERS.map(csvEscapeCell).join(",");
    const body = rows.map(rowToCsv).join("\r\n");
    const stamp = new Date();
    const name = `FA登记_${stamp.getFullYear()}${String(stamp.getMonth() + 1).padStart(2, "0")}${String(stamp.getDate()).padStart(2, "0")}_${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}.csv`;
    downloadTextFile(name, `\uFEFF${headerLine}\r\n${body}\r\n`, "text/csv;charset=utf-8");
    setSyncStatus("已下载 CSV。");
  }

  return (
    <div>
      <h1 className={page.pageTitle}>信息登记</h1>
      <p className={page.pageDesc}>
        飞书 <strong>docx</strong> 链接的正文须由 <code>sync-server</code> 拉取（浏览器不能直接读飞书页面）。环境与授权见顶部<strong>帮助</strong>；用户授权请点顶部<strong>飞书登录</strong>。本页下方填写同步服务地址与令牌。
      </p>

      <ul className={page.steps} aria-label="登记流程">
        <li className={`${page.step} ${page.stepActive}`}>1. 粘贴链接 / 文档</li>
        <li className={page.step}>2. 一键抽取（+ 可选同步飞书）</li>
        <li className={page.step}>3. 查看横表与附加段落</li>
      </ul>

      <div className={page.panel}>
        <label className={page.label} htmlFor="batch-input">
          批量输入（识别约 {parsedCount} 个 Case）
        </label>
        <p className={styles.hint}>
          每行一条链接可拆成多 Case；或每段之间用单独一行的 <code>---</code> 分隔，段内首行可为链接、其余为正文。
        </p>
        <textarea
          id="batch-input"
          className={styles.batchTextarea}
          placeholder={`https://doc1...\nhttps://doc2...\n\n或：\nhttps://...\nTitle: ...\nBasic Information: ...\n---\nhttps://...\n...`}
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
          rows={12}
        />

        <div id="workbench-feishu-settings" className={styles.topFields} style={{ marginTop: "1rem" }}>
          <div>
            <label className={page.label} htmlFor="sheet-url">
              飞书表格链接（展示用；写入以 .env 中 token 为准）
            </label>
            <input
              id="sheet-url"
              className={page.input}
              type="url"
              value={sheetUrl}
              onChange={(event) => setSheetUrl(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={page.label} htmlFor="sync-endpoint">
              同步服务地址
            </label>
            <input
              id="sync-endpoint"
              className={page.input}
              type="url"
              value={syncEndpoint}
              onChange={(event) => setSyncEndpoint(event.target.value)}
              autoComplete="off"
            />
          </div>
          <div>
            <label className={page.label} htmlFor="user-access-token">
              用户访问令牌（user_access_token，可选，推荐）
            </label>
            <input
              id="user-access-token"
              className={page.input}
              type="password"
              value={userAccessToken}
              onChange={(event) => setUserAccessToken(event.target.value)}
              autoComplete="off"
              placeholder="OAuth 后为 JWT，或旧版 u- 开头；填写后按用户权限读文档"
            />
            <p className={styles.tokenHint}>
              仅存本机浏览器；清空后回退应用身份读文档。OAuth 授权请使用顶部<strong>飞书登录</strong>（勿关本页标签）。
            </p>
          </div>
        </div>

        <label className={styles.checkboxLine}>
          <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} />
          抽取后自动同步到飞书（子表：HESAI FA Tracking Sheet V1.0）
        </label>

        <div className={page.row}>
          <button
            type="button"
            className={`${page.btn} ${page.btnPrimary}`}
            onClick={() => void runExtractAndSync()}
            disabled={parsedCount === 0 || extracting}
          >
            {extracting ? "处理中…" : "一键抽取" + (autoSync ? "并同步飞书" : "")}
          </button>
          <button
            type="button"
            className={page.btn}
            onClick={() => void runExtractionOnly()}
            disabled={parsedCount === 0 || extracting}
          >
            仅抽取
          </button>
          <button
            type="button"
            className={page.btn}
            onClick={() => void syncToSheetWithRows(rows).then((r) => applySyncResult(r))}
            disabled={rows.length === 0}
          >
            仅同步（当前表）
          </button>
          <button type="button" className={page.btn} onClick={copyAsTsv} disabled={rows.length === 0}>
            复制 TSV
          </button>
          <button type="button" className={page.btn} onClick={downloadCsvForExcel} disabled={rows.length === 0}>
            下载 CSV
          </button>
        </div>

        {syncStatus && <p className={styles.status}>{syncStatus}</p>}
        {syncFeishuDetail != null && (
          <div
            ref={feishuErrorPanelRef}
            className={styles.feishuErrorPanel}
            role="region"
            aria-label="飞书接口返回"
          >
            <p className={styles.feishuErrorTitle}>
              飞书接口返回（位置：本卡片内、按钮正下方；若已出现「抽取结果」大表格，请向上滚回此处）
            </p>
            {syncFeishuDetail.feishu != null || syncFeishuDetail.debug != null ? (
              <>
                {syncFeishuDetail.feishu != null && (
                  <pre className={styles.feishuErrorPre}>
                    {JSON.stringify(syncFeishuDetail.feishu, null, 2)}
                  </pre>
                )}
                {syncFeishuDetail.debug != null && (
                  <>
                    <p className={styles.feishuErrorSub}>调试信息（range、表头等）</p>
                    <pre className={styles.feishuErrorPre}>
                      {JSON.stringify(syncFeishuDetail.debug, null, 2)}
                    </pre>
                  </>
                )}
              </>
            ) : syncFeishuDetail.errorBodyWasJson ? (
              <>
                <p className={styles.feishuErrorFallback}>
                  响应体<strong>已是合法 JSON</strong>，其中 <code>feishuResponse</code> 与 <code>debug</code> 字段为{" "}
                  <code>null</code>（没有附带飞书原始返回体），因此这里不显示大块 JSON。错误摘要见上方灰色状态行；完整响应仍可在 F12
                  →「网络」→ <code>sync-feishu</code> →「响应」中查看。
                </p>
                {syncFeishuDetail.serverMessage != null && syncFeishuDetail.serverMessage !== "" && (
                  <>
                    <p className={styles.feishuErrorSub}>服务端 message 字段（便于复制）</p>
                    <pre className={styles.feishuErrorPre}>{syncFeishuDetail.serverMessage}</pre>
                  </>
                )}
              </>
            ) : (
              <p className={styles.feishuErrorFallback}>
                响应体<strong>不是合法 JSON</strong>（例如代理返回了 HTML）。请按 F12 →「网络」→ 选中{" "}
                <code>sync-feishu</code> →「响应」查看原文；或查看运行 <code>npm run sync-server</code> 的终端日志。
              </p>
            )}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className={`${page.panel} ${styles.resultPanel}`}>
          <h2 className={styles.blockTitle}>抽取结果（横表 + 附加段落）</h2>
          <div className={styles.tableWrap}>
            <table className={styles.resultTable}>
              <thead>
                <tr>
                  {TABLE_HEADERS.map((header) => (
                    <th key={header}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.docLink}-${index}`}>
                    <td>{row.feedbackTime}</td>
                    <td>{row.contact}</td>
                    <td>{row.traceCode}</td>
                    <td>{row.customerInfo}</td>
                    <td>{row.priority}</td>
                    <td>{row.machineInfo}</td>
                    <td>{row.chipModel}</td>
                    <td>{row.failCount}</td>
                    <td>{row.mileage}</td>
                    <td>
                      {row.docLink === "原链接" ? (
                        "原链接"
                      ) : (
                        <a href={row.docLink} target="_blank" rel="noopener noreferrer">
                          {row.documentName && row.documentName !== "无法解析"
                            ? row.documentName
                            : row.docLink}
                        </a>
                      )}
                    </td>
                    <td>{row.failureSymptom}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.inlineParagraphs}>
            {rows.map((row, index) => (
              <article key={`para-${index}`} className={styles.paragraphCard}>
                <p className={styles.caseTag}>Case {index + 1} · 附加说明</p>
                <p>
                  背景概述：文档名称为“{row.documentName}”，文档链接为“{row.docLink || "原链接"}”。
                </p>
                <p>
                  方案简述：当前的电性表现是“{row.problemSummary}问题”，需要通过“{row.troubleshootMethod}”手段排查该问题，预估费用为5000元以内。
                </p>
                <p>风险：FA风险低。</p>
                <p>预计收益：预计3天内完成FA定位，协助质量部门关闭问题。</p>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
