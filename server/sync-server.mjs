/**
 * 本地飞书写入服务：读项目根目录 .env，将登记页 POST 的行数据追加到指定子表。
 * 文档：https://open.feishu.cn/document/server-docs/docs/sheets-v3/data-operation/append-data
 */
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function loadEnv() {
  const envCandidates = [path.join(root, ".env"), path.join(root, ".env.example")];
  for (const envPath of envCandidates) {
    try {
      const raw = readFileSync(envPath, "utf8");
      for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const i = t.indexOf("=");
        if (i <= 0) continue;
        const k = t.slice(0, i).trim();
        let v = t.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
          v = v.slice(1, -1);
        process.env[k] = v;
      }
      return path.basename(envPath);
    } catch {
      // 尝试下一个候选文件
    }
  }
  return null;
}

const ENV_SOURCE = loadEnv();

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const SPREADSHEET_TOKEN = process.env.FEISHU_SPREADSHEET_TOKEN;
const SHEET_TITLE = process.env.FEISHU_SHEET_TITLE || "HESAI FA Tracking Sheet V1.0";
/** 云主机常用 PORT；本地仍可用 SERVER_PORT */
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3789);
/** 可选：设置后请求须带 Authorization: Bearer <key> 或 X-Api-Key，降低公网接口被滥用风险 */
const SYNC_API_KEY = (process.env.SYNC_API_KEY || "").trim();
/** 与飞书开发者后台「安全设置 → 重定向 URL」完全一致。本地推荐直连本服务：http://127.0.0.1:3789/api/auth/feishu/callback */
const OAUTH_REDIRECT_URI = (process.env.FEISHU_OAUTH_REDIRECT_URI || "").trim();
/** 授权页 scope，须为应用已开通权限的子集；建议含 offline_access 以便换 refresh_token */
const OAUTH_SCOPE = (process.env.FEISHU_OAUTH_SCOPE || "").trim();

if (OAUTH_REDIRECT_URI) {
  try {
    const u = new URL(OAUTH_REDIRECT_URI);
    const redirectPort = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    const pathNorm = u.pathname.replace(/\/$/, "") || "/";
    if (
      pathNorm.endsWith("/api/auth/feishu/callback") &&
      redirectPort !== PORT &&
      (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    ) {
      console.warn(
        `[sync-server] OAuth 重定向为 ${u.origin}（端口 ${redirectPort}），与本服务端口 ${PORT} 不一致。授权完成时浏览器会请求该端口：须全程运行 Vite；否则易出现 ERR_CONNECTION_REFUSED。建议改为 http://127.0.0.1:${PORT}/api/auth/feishu/callback 并在飞书后台同步修改。`,
      );
    }
  } catch {
    /* ignore invalid FEISHU_OAUTH_REDIRECT_URI */
  }
}

/** OAuth state 临时存储：防 CSRF，并记录弹窗父页 origin（用于 postMessage） */
const oauthStates = new Map();
/**
 * 读 A1:ZZ1 时飞书常返回数百个尾随空单元格，若不裁剪会得到 702 列、append 使用 A:ZZ 触发 90202。
 * 可在 .env 设置 FEISHU_MAX_SYNC_COLUMNS（默认 80，上限 200）。
 */
const MAX_SYNC_COLUMNS = Math.min(Math.max(1, Number(process.env.FEISHU_MAX_SYNC_COLUMNS) || 80), 200);
/** 表头名与飞书第 1 行一致；写入时用 multipleValue 以匹配「单选/下拉」列（选项文案须与单元格值完全一致） */
const DROPDOWN_HEADERS = new Set(
  (process.env.FEISHU_DROPDOWN_HEADERS || "客户信息,优先级")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean),
);
/**
 * 追加方式：OVERWRITE=写入既有空行（更易继承下拉验证）；INSERT_ROWS=先插新行再写。
 * 设错值时回退 OVERWRITE。
 */
const INSERT_DATA_OPTION =
  String(process.env.FEISHU_INSERT_DATA_OPTION || "OVERWRITE").toUpperCase() === "INSERT_ROWS"
    ? "INSERT_ROWS"
    : "OVERWRITE";

function trimTrailingEmptyCells(arr) {
  const a = Array.isArray(arr) ? [...arr] : [];
  while (a.length > 0) {
    const v = a[a.length - 1];
    const s = v == null ? "" : String(v).trim();
    if (s !== "") break;
    a.pop();
  }
  return a;
}

/** 去掉尾部空列后再按上限截断，保证 range 为 A:K 量级而非 A:ZZ */
function normalizeHeaderRowFromFeishu(row) {
  let a = trimTrailingEmptyCells(row);
  if (a.length > MAX_SYNC_COLUMNS) {
    console.warn(
      `[sync-server] 表头列数 ${a.length} 超过上限 ${MAX_SYNC_COLUMNS}，已截断（可在 .env 增大 FEISHU_MAX_SYNC_COLUMNS）`,
    );
    a = a.slice(0, MAX_SYNC_COLUMNS);
  }
  return a;
}

function excelColName(indexZeroBased) {
  let n = indexZeroBased + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

async function getTenantToken() {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw syncError(data.msg || `获取 tenant_access_token 失败: ${JSON.stringify(data)}`, data, {
      step: "tenant_access_token",
    });
  }
  return data.tenant_access_token;
}

function maskToken(token) {
  const t = String(token || "");
  if (t.length <= 12) return `${t.slice(0, 3)}***`;
  return `${t.slice(0, 6)}...${t.slice(-4)}`;
}

async function querySheets(token) {
  const url = `https://open.feishu.cn/open-apis/sheets/v3/spreadsheets/${SPREADSHEET_TOKEN}/sheets/query`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) {
    throw syncError(data.msg || `获取工作表失败: ${JSON.stringify(data)}`, data, { step: "sheets_query" });
  }
  return data.data.sheets;
}

async function readHeaderRow(token, sheetId) {
  /**
   * 勿使用 sheetId!1:1：飞书常报 90202 validate RangeVal fail（与 values_append 需用 A 列区间同理）。
   * 只读第 1 行表头，用 A1:ZZ1 覆盖足够多列（与 append 侧列字母写法一致）。
   */
  const rangeLiteral = `${sheetId}!A1:ZZ1`;
  const range = encodeURIComponent(rangeLiteral);
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (data.code !== 0) {
    throw syncError(data.msg || `读取表头失败: ${JSON.stringify(data)}`, data, {
      step: "read_header_row",
      rangeRequested: rangeLiteral,
      sheetId,
    });
  }
  const raw = data.data?.valueRange?.values?.[0] || [];
  return normalizeHeaderRowFromFeishu(raw);
}

/**
 * 飞书「支持写入的数据类型」中带文本的超链接：{ type, text, link }。
 * 见：https://open.feishu.cn/document/ukTMukTMukTM/ugjN1UjL4YTN14CO2UTN
 */
function cellValueForFeishu(v) {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && !Array.isArray(v) && v.type === "url" && typeof v.link === "string") {
    const link = v.link.trim();
    const text = typeof v.text === "string" && v.text.trim() ? v.text.trim() : link;
    if (!/^https?:\/\//i.test(link)) return text;
    return { type: "url", text, link };
  }
  return String(v);
}

/**
 * 飞书单选/下拉列需写入 { type: "multipleValue", values: ["选项"] }，与纯文本区分。
 * 选项文案须与列上已配置的下拉项完全一致；值中含英文逗号时无法使用该类型，退回纯字符串。
 * 见：https://open.feishu.cn/document/ukTMukTMukTM/ugjN1UjL4YTN14CO2UTN
 */
function wrapDropdownIfNeeded(headerLabel, cell) {
  if (!DROPDOWN_HEADERS.has(headerLabel)) return cell;
  if (typeof cell !== "string" || !cell.trim()) return cell;
  if (cell.includes(",")) return cell;
  return { type: "multipleValue", values: [cell.trim()] };
}

/**
 * 按「表头文字」对齐，不是按列序号：飞书第 1 行每个单元格作为 key，从 payload 行对象 row[key] 取值；
 * 列顺序由飞书表头从左到右决定，与前端 headers 数组顺序无关（只要 key 与表头字符串一致）。
 */
function buildDataRows(headerRow, payloadRows) {
  const headers = headerRow.map((h) => (h == null ? "" : String(h).trim()));
  return payloadRows.map((row) =>
    headers.map((h) => {
      if (!h) return "";
      const v = row[h];
      const base = cellValueForFeishu(v);
      return wrapDropdownIfNeeded(h, base);
    }),
  );
}

function syncError(message, feishuResponse, syncDebug) {
  return Object.assign(new Error(message), { feishuResponse, syncDebug });
}

/** 每行列数与表头列数严格一致，避免飞书 90202 validate RangeVal fail */
function normalizeValueMatrix(headerLen, values) {
  return values.map((row) => {
    const r = Array.isArray(row) ? [...row] : [];
    while (r.length < headerLen) r.push("");
    return r.slice(0, headerLen);
  });
}

async function appendValues(token, sheetId, headerRow, values) {
  if (values.length === 0) return { updatedRows: 0 };
  const headerLen = Math.max(headerRow.length, 1);
  const rows = normalizeValueMatrix(headerLen, values);
  const lastIdx = headerLen - 1;
  const lastCol = excelColName(Math.max(lastIdx, 0));
  /**
   * 使用「列区间」写法（如 sheetId!A:K），避免 A1:K3000 等在某些表格上报 validate RangeVal fail。
   * 见：电子表格 range 写法说明
   */
  const range = `${sheetId}!A:${lastCol}`;
  const url = `https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${SPREADSHEET_TOKEN}/values_append?insertDataOption=${INSERT_DATA_OPTION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      valueRange: { range, values: rows },
    }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    const extra =
      data.code === 90202 || /RangeVal|validate/i.test(String(data.msg))
        ? "（可检查：① range 是否合法；② 目标列是否设置了「数据验证」导致文本无法写入，可先取消该列验证再试）"
        : "";
    console.error("[sync-server] Feishu values_append 失败:", JSON.stringify(data, null, 2));
    throw syncError(`${data.msg || "追加数据失败"}${extra}`, data, {
      range,
      columnCount: headerLen,
      lastCol,
      /** 仅前 10 格，避免 JSON 里塞满数百个 "" */
      valuePreview: rows[0] ? rows[0].slice(0, 10) : [],
      insertDataOption: INSERT_DATA_OPTION,
    });
  }
  return data.data?.updates || {};
}

/** 从飞书文档 URL 解析 docx 文档 token（路径含 /docx/） */
function parseDocxDocumentId(urlStr) {
  const s = String(urlStr).trim();
  const m = s.match(/\/docx\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * 拉取云文档正文（需应用具备 docx 文档读取权限，并在控制台发布版本）
 * https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/raw_content
 */
async function fetchDocxRawText(accessToken, documentId, authMode = "tenant") {
  const apiUrl = `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`;
  const res = await fetch(apiUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (data.code !== 0) {
    const hint =
      /permission|无权限|scope|权限/i.test(String(data.msg)) && authMode === "tenant"
        ? "（请在该云文档右上角「…」→「添加文档应用」授权本应用，并在开放平台为应用开通云文档读取相关权限后重新发布应用。）"
        : /permission|无权限|scope|权限|expired|invalid/i.test(String(data.msg)) && authMode === "user"
          ? "（当前 user_access_token 无权限或已失效。请确认：① 该用户本身可访问文档；② token 为最新 user_access_token；③ 若公司策略限制跨空间，改用同空间文档。）"
          : "";
    throw new Error(`${data.msg || "读取云文档失败"}${hint} 详情：${JSON.stringify(data)}`);
  }
  const raw = data.data?.content;
  if (typeof raw === "string" && raw.trim().length > 0) return raw;
  if (raw && typeof raw === "object") {
    try {
      const s = JSON.stringify(raw);
      if (s.length > 2) return s;
    } catch {
      /* fall through */
    }
  }
  throw new Error(
    "飞书返回的正文为空。请确认：① 开放平台已申请并发布「查看/导出云文档」类权限；② 在该文档中已添加本应用；③ 文档非加密或外链仅预览等受限场景。",
  );
}

function buildFeishuDocWebUrl(type, token) {
  const t = String(type || "");
  const k = String(token || "");
  if (!k) return "";
  if (t === "docx") return `https://feishu.cn/docx/${k}`;
  if (t === "sheet") return `https://feishu.cn/sheets/${k}`;
  if (t === "wiki") return `https://feishu.cn/wiki/${k}`;
  if (t === "bitable") return `https://feishu.cn/base/${k}`;
  if (t === "doc") return `https://feishu.cn/docs/${k}`;
  return "";
}

/**
 * 基于用户态 token 拉取「当前用户可读」云文档列表（Drive）。
 * 文档类型以 doc/docx/sheet/wiki/bitable 为主；可按需扩展。
 */
async function listReadableDriveDocs(userAccessToken, options = {}) {
  const maxPages = Math.min(Math.max(1, Number(options.maxPages) || 20), 60);
  const pageSize = Math.min(Math.max(20, Number(options.pageSize) || 200), 200);
  const all = [];
  const queue = [""];
  const visitedFolders = new Set();
  let pageBudget = maxPages;
  while (queue.length > 0 && pageBudget > 0) {
    const folderToken = String(queue.shift() || "");
    if (visitedFolders.has(folderToken)) continue;
    visitedFolders.add(folderToken);
    let pageToken = "";
    for (;;) {
      if (pageBudget <= 0) break;
      pageBudget -= 1;
      const u = new URL("https://open.feishu.cn/open-apis/drive/v1/files");
      u.searchParams.set("page_size", String(pageSize));
      if (folderToken) u.searchParams.set("folder_token", folderToken);
      if (pageToken) u.searchParams.set("page_token", pageToken);
      const res = await fetch(u.toString(), {
        headers: { Authorization: `Bearer ${userAccessToken}` },
      });
      const data = await res.json();
      if (data.code !== 0) {
        throw syncError(data.msg || `拉取可读云文档失败: ${JSON.stringify(data)}`, data, {
          step: "drive_files_list",
          folderToken,
        });
      }
      const files = Array.isArray(data?.data?.files) ? data.data.files : [];
      all.push(...files);
      for (const f of files) {
        if (!f || typeof f !== "object") continue;
        const type = String(f.type || "");
        if (type === "folder") {
          const token = String(f.token || "");
          if (token && !visitedFolders.has(token)) queue.push(token);
        }
      }
      const hasMore = Boolean(data?.data?.has_more);
      pageToken = typeof data?.data?.next_page_token === "string" ? data.data.next_page_token : "";
      if (!hasMore || !pageToken) break;
    }
  }
  const allowTypes = new Set(["doc", "docx", "sheet", "wiki", "bitable"]);
  const dedup = new Map();
  for (const f of all) {
    if (!f || typeof f !== "object") continue;
    const type = String(f.type || "");
    if (!allowTypes.has(type)) continue;
    const token = String(f.token || "");
    const title = String(f.name || f.title || token || "未命名文档");
    const url = typeof f.url === "string" && f.url.trim() ? f.url.trim() : buildFeishuDocWebUrl(type, token);
    const id = `${type}:${token || title}`;
    const updatedAtRaw = Number(f.modified_time || f.updated_time || Date.now());
    const updatedAt = Number.isFinite(updatedAtRaw) ? updatedAtRaw : Date.now();
    dedup.set(id, { id, title, type, token, url, updatedAt });
  }
  return [...dedup.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 飞书 search/v2 文档与知识库搜索，可发现「非我创建但有阅读权」等 Drive 树未列全的文档（需应用具备 search:docs:read 等搜索类权限，以开发者后台为准）。
 * 返回结构会随平台调整，这里对常见字段做了兼容解析。
 */
function normalizeDocWikiSearchItem(hit) {
  if (!hit || typeof hit !== "object") return null;
  const tRaw = String(
    hit.obj_type || hit.document_type || hit.docs_type || hit.doc_type || hit.type || "docx",
  )
    .toLowerCase()
    .replace(/\s+/g, "");
  let type = "docx";
  if (tRaw.includes("sheet")) type = "sheet";
  else if (tRaw.includes("bitable") || tRaw === "base") type = "bitable";
  else if (tRaw.includes("wiki")) type = "wiki";
  else if (tRaw === "doc" && !tRaw.includes("docx")) type = "doc";
  const token = String(
    hit.doc_token || hit.docs_token || hit.obj_token || hit.token || hit.id || "",
  ).trim();
  if (!token) return null;
  const title = String(hit.title || hit.name || hit.summary || "未命名文档");
  let url = typeof hit.url === "string" && hit.url.trim() ? hit.url.trim() : "";
  if (!url) url = buildFeishuDocWebUrl(type, token);
  const upd = Number(
    hit.edit_time || hit.last_edit_time || hit.last_open_time || hit.update_time || hit.modified_time,
  );
  const updatedAt = Number.isFinite(upd) && upd > 0 ? upd * (upd < 1e12 ? 1000 : 1) : Date.now();
  return { id: `${type}:${token}`, title, type, token, url, updatedAt };
}

function extractSearchDocsFromResponse(data) {
  const d = data?.data;
  const raw = []
    .concat(Array.isArray(d?.docs) ? d.docs : [])
    .concat(Array.isArray(d?.items) ? d.items : [])
    .concat(Array.isArray(d?.doc_list) ? d.doc_list : []);
  const out = [];
  for (const hit of raw) {
    const n = normalizeDocWikiSearchItem(hit);
    if (n) out.push(n);
  }
  return out;
}

async function feishuSearchDocWikiRequest(userAccessToken, body) {
  const res = await fetch("https://open.feishu.cn/open-apis/search/v2/doc_wiki/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${userAccessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * 按关键词搜索当前用户可访问的在线文档/wiki（多页，与 Drive 列表合并前可二次去重）。
 */
async function collectDocWikiSearch(userAccessToken, query, options = {}) {
  const maxPages = Math.min(Math.max(1, Number(options.maxPages) || 3), 20);
  const q = String(query || "").trim().slice(0, 50);
  if (!q) return { docs: [], searchError: null };
  const seen = new Map();
  let searchError = null;
  let pageToken = "";
  for (let p = 0; p < maxPages; p++) {
    const body = {
      query: q,
      page_size: 20,
      doc_filter: {
        doc_types: ["DOCX", "DOC", "SHEET", "BITABLE"],
      },
    };
    if (pageToken) body.page_token = pageToken;
    const data = await feishuSearchDocWikiRequest(userAccessToken, body);
    if (data.code !== 0) {
      searchError = data.msg || JSON.stringify(data);
      break;
    }
    for (const doc of extractSearchDocsFromResponse(data)) seen.set(doc.id, doc);
    const hasMore = Boolean(data?.data?.has_more);
    pageToken =
      typeof data?.data?.page_token === "string"
        ? data.data.page_token
        : typeof data?.data?.next_page_token === "string"
          ? data.data.next_page_token
          : "";
    if (!hasMore || !pageToken) break;
  }
  const wikiTry = await feishuSearchDocWikiRequest(userAccessToken, {
    query: q,
    page_size: 20,
    wiki_filter: {
      doc_types: ["WIKI"],
    },
  });
  if (wikiTry.code === 0) {
    for (const doc of extractSearchDocsFromResponse(wikiTry)) seen.set(doc.id, doc);
  }
  return { docs: [...seen.values()], searchError };
}

/** 同步时用若干种子词扩展搜索，尽量覆盖共享文档（仍受租户搜索权限限制）。 */
async function expandDriveDocsWithSearch(userAccessToken, driveDocs, options = {}) {
  const seeds = Array.isArray(options.searchSeeds)
    ? options.searchSeeds.filter((x) => typeof x === "string")
    : ["报告", "方案", "测试", "总结", "FA"];
  const maxSeedQueries = Math.min(Math.max(1, Number(options.maxSeedQueries) || 6), 12);
  const dedup = new Map();
  for (const d of driveDocs) dedup.set(d.id, d);
  let lastErr = null;
  for (const seed of seeds.slice(0, maxSeedQueries)) {
    try {
      const { docs, searchError } = await collectDocWikiSearch(userAccessToken, seed, { maxPages: 2 });
      if (searchError && docs.length === 0) lastErr = searchError;
      for (const doc of docs) dedup.set(doc.id, doc);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { docs: [...dedup.values()].sort((a, b) => b.updatedAt - a.updatedAt), expandWarning: lastErr };
}

async function webSearchLite(query) {
  const q = String(query || "").trim();
  if (!q) return [];
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url);
  const data = await res.json();
  const out = [];
  const abstract = typeof data?.AbstractText === "string" ? data.AbstractText.trim() : "";
  const abstractUrl = typeof data?.AbstractURL === "string" ? data.AbstractURL : "";
  if (abstract) out.push({ title: data?.Heading || q, snippet: abstract, url: abstractUrl });
  const related = Array.isArray(data?.RelatedTopics) ? data.RelatedTopics : [];
  for (const t of related) {
    if (!t || typeof t !== "object") continue;
    if (typeof t.Text === "string" && t.Text.trim()) {
      out.push({ title: q, snippet: t.Text.trim(), url: typeof t.FirstURL === "string" ? t.FirstURL : "" });
    }
    if (Array.isArray(t.Topics)) {
      for (const s of t.Topics) {
        if (s && typeof s === "object" && typeof s.Text === "string" && s.Text.trim()) {
          out.push({
            title: q,
            snippet: s.Text.trim(),
            url: typeof s.FirstURL === "string" ? s.FirstURL : "",
          });
        }
      }
    }
    if (out.length >= 8) break;
  }
  return out.slice(0, 8);
}

/** 知识库网页链接学习：粗提取可见文本（非完整渲染） */
function stripHtmlToPlainText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function sendJson(res, status, body, origin) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
  });
  res.end(JSON.stringify(body));
}

function checkApiKey(req, res, origin) {
  if (!SYNC_API_KEY) return true;
  const auth = req.headers.authorization;
  const key = req.headers["x-api-key"];
  const ok = auth === `Bearer ${SYNC_API_KEY}` || key === SYNC_API_KEY;
  if (!ok) {
    sendJson(res, 401, { ok: false, error: "unauthorized", message: "缺少或错误的 API 密钥" }, origin);
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function purgeOldOAuthStates() {
  const now = Date.now();
  for (const [s, meta] of oauthStates) {
    if (now - meta.createdMs > 10 * 60 * 1000) oauthStates.delete(s);
  }
}

/** 登录页 query：next_origin，解码后须为 http(s) origin */
function parseNextOriginParam(raw) {
  if (raw == null || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  const candidates = [t, decodeURIComponent(t)];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      return u.origin;
    } catch {
      /* try next */
    }
  }
  return null;
}

function safeRedirectOriginFromEnv() {
  if (!OAUTH_REDIRECT_URI) return "*";
  try {
    return new URL(OAUTH_REDIRECT_URI).origin;
  } catch {
    return "*";
  }
}

function sendHtml(res, status, html, allowOrigin) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Access-Control-Allow-Origin": allowOrigin || "*",
  });
  res.end(html);
}

/**
 * 解析 Node 收到的 req.url：一般为 "/path?a=1"；经部分反向代理时可能为绝对 URL。
 * 仅用 pathname 做路由匹配，避免 OAuth 等 GET 误落 404。
 */
function parseIncomingUrl(req) {
  const raw = typeof req.url === "string" && req.url.length > 0 ? req.url : "/";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return new URL(raw);
    const host = req.headers.host || `127.0.0.1:${PORT}`;
    return new URL(raw, `http://${host}`);
  } catch {
    return new URL(`http://127.0.0.1:${PORT}/`);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "*";

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  const incoming = parseIncomingUrl(req);
  const pathname = incoming.pathname;

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true, service: "feishu-sync" }, origin);
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/feishu/login") {
    purgeOldOAuthStates();
    const nextOrigin = parseNextOriginParam(incoming.searchParams.get("next_origin") || "");
    if (!APP_ID || !APP_SECRET) {
      sendJson(
        res,
        500,
        { ok: false, error: "missing_env", message: "需要 FEISHU_APP_ID / FEISHU_APP_SECRET 才能发起用户授权" },
        origin,
      );
      return;
    }
    if (!OAUTH_REDIRECT_URI) {
      sendJson(
        res,
        500,
        {
          ok: false,
          error: "missing_oauth_redirect",
          message: "请在 .env 配置 FEISHU_OAUTH_REDIRECT_URI，且与飞书开发者后台「重定向 URL」完全一致",
        },
        origin,
      );
      return;
    }
    const state = crypto.randomBytes(16).toString("hex");
    oauthStates.set(state, { createdMs: Date.now(), returnOrigin: nextOrigin });
    const params = new URLSearchParams({
      client_id: APP_ID,
      response_type: "code",
      redirect_uri: OAUTH_REDIRECT_URI,
      state,
      prompt: "consent",
    });
    if (OAUTH_SCOPE) params.set("scope", OAUTH_SCOPE);
    const loc = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${params.toString()}`;
    res.writeHead(302, { Location: loc, "Access-Control-Allow-Origin": origin || "*" });
    res.end();
    return;
  }

  if (req.method === "GET" && pathname === "/api/auth/feishu/callback") {
    const code = incoming.searchParams.get("code");
    const state = incoming.searchParams.get("state");
    const errParam = incoming.searchParams.get("error");
    const meta = state ? oauthStates.get(state) : undefined;
    const targetOrigin = meta?.returnOrigin || safeRedirectOriginFromEnv();

    const oauthResultHtml = (payload) => {
      const body = JSON.stringify(payload);
      return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>飞书授权</title></head><body><script>
(function(){
  var payload = ${body};
  var targetOrigin = ${JSON.stringify(targetOrigin)};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(Object.assign({ source: "feishu-oauth" }, payload), targetOrigin);
    }
  } catch (e) {}
  setTimeout(function(){ window.close(); }, 200);
})();
</script><p style="font-family:system-ui,sans-serif;padding:1rem">授权处理完毕，请回到工作台窗口。若未自动关闭，可手动关闭本页。</p></body></html>`;
    };

    if (errParam === "access_denied") {
      if (state) oauthStates.delete(state);
      sendHtml(res, 200, oauthResultHtml({ ok: false, error: "access_denied" }), origin);
      return;
    }
    if (errParam) {
      sendHtml(res, 200, oauthResultHtml({ ok: false, error: errParam }), origin);
      return;
    }
    if (!code || !state || !meta) {
      sendHtml(
        res,
        200,
        oauthResultHtml({
          ok: false,
          error: "invalid_callback",
          message: "缺少 code/state 或 state 已过期，请关闭后重新点击「飞书授权」",
        }),
        origin,
      );
      return;
    }
    oauthStates.delete(state);

    if (!APP_ID || !APP_SECRET || !OAUTH_REDIRECT_URI) {
      sendHtml(
        res,
        200,
        oauthResultHtml({ ok: false, error: "server_misconfigured", message: "服务端缺少 OAuth 配置" }),
        origin,
      );
      return;
    }

    try {
      const tokenRes = await fetch("https://open.feishu.cn/open-apis/authen/v2/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: APP_ID,
          client_secret: APP_SECRET,
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
        }),
      });
      const tr = await tokenRes.json();
      const inner = tr && typeof tr === "object" && tr.data != null ? tr.data : tr;
      const accessToken =
        typeof inner?.access_token === "string"
          ? inner.access_token
          : typeof tr?.access_token === "string"
            ? tr.access_token
            : "";
      if (tr && typeof tr === "object" && tr.code !== 0 && tr.code !== undefined) {
        sendHtml(res, 200, oauthResultHtml({ ok: false, error: "token_exchange", detail: tr }), origin);
        return;
      }
      if (!accessToken) {
        sendHtml(res, 200, oauthResultHtml({ ok: false, error: "token_exchange", detail: tr }), origin);
        return;
      }
      const refreshToken =
        typeof inner?.refresh_token === "string"
          ? inner.refresh_token
          : typeof tr?.refresh_token === "string"
            ? tr.refresh_token
            : "";
      sendHtml(
        res,
        200,
        oauthResultHtml({
          ok: true,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: inner?.expires_in ?? tr?.expires_in,
          refresh_token_expires_in: inner?.refresh_token_expires_in ?? tr?.refresh_token_expires_in,
          scope: inner?.scope ?? tr?.scope ?? "",
        }),
        origin,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendHtml(res, 200, oauthResultHtml({ ok: false, error: "token_exchange", message }), origin);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/fetch-feishu-doc") {
    if (!checkApiKey(req, res, origin)) return;
    try {
      const body = await readBody(req);
      const url = body?.url;
      const userAccessToken =
        typeof body?.userAccessToken === "string" ? body.userAccessToken.trim() : "";
      if (!url || typeof url !== "string") {
        sendJson(res, 400, { ok: false, error: "invalid_body", message: "需要 JSON 字段 url" }, origin);
        return;
      }
      const docId = parseDocxDocumentId(url);
      if (!docId) {
        sendJson(
          res,
          400,
          {
            ok: false,
            error: "unsupported_url",
            message: "仅支持飞书新版文档链接（路径含 /docx/）。wiki 或其它格式请粘贴正文。",
          },
          origin,
        );
        return;
      }
      /** OAuth 返回的 user_access_token 多为 JWT（eyJ…）；旧版也可能为 u- 前缀，统一按「非空即用户态」 */
      const useUserToken = userAccessToken.length >= 10;
      if (!useUserToken && (!APP_ID || !APP_SECRET)) {
        sendJson(
          res,
          500,
          { error: "missing_env", message: "请配置 FEISHU_APP_ID、FEISHU_APP_SECRET，或传 user_access_token" },
          origin,
        );
        return;
      }
      const token = useUserToken ? userAccessToken : await getTenantToken();
      const authMode = useUserToken ? "user" : "tenant";
      const text = await fetchDocxRawText(token, docId, authMode);
      sendJson(
        res,
        200,
        {
          ok: true,
          text,
          documentId: docId,
          authMode,
          tokenMasked: maskToken(token),
        },
        origin,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { ok: false, error: "fetch_doc_failed", message }, origin);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/list-feishu-readable-docs") {
    if (!checkApiKey(req, res, origin)) return;
    try {
      const body = await readBody(req);
      const userAccessToken =
        typeof body?.userAccessToken === "string" ? body.userAccessToken.trim() : "";
      if (userAccessToken.length < 10) {
        sendJson(
          res,
          400,
          {
            ok: false,
            error: "missing_user_access_token",
            message: "请先完成飞书 OAuth 登录，提供 userAccessToken。",
          },
          origin,
        );
        return;
      }
      const driveDocs = await listReadableDriveDocs(userAccessToken, {
        maxPages: body?.maxPages,
        pageSize: body?.pageSize,
      });
      const merged = await expandDriveDocsWithSearch(userAccessToken, driveDocs, {
        maxSeedQueries: body?.maxSeedQueries,
        searchSeeds: Array.isArray(body?.searchSeeds) ? body.searchSeeds : undefined,
      });
      const docs = merged.docs;
      sendJson(
        res,
        200,
        {
          ok: true,
          total: docs.length,
          driveListingCount: driveDocs.length,
          mergedSearch: docs.length > driveDocs.length,
          docs,
          hint:
            docs.length === 0
              ? "接口可用但返回 0 条：请确认该账号在飞书中确有可读文档，且应用权限已发布并重新授权。"
              : undefined,
          expandWarning: merged.expandWarning || undefined,
        },
        origin,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const feishuResponse =
        e && typeof e === "object" && "feishuResponse" in e ? e.feishuResponse : undefined;
      sendJson(
        res,
        500,
        {
          ok: false,
          error: "list_readable_docs_failed",
          message,
          feishuResponse: feishuResponse ?? null,
        },
        origin,
      );
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/web-search-lite") {
    if (!checkApiKey(req, res, origin)) return;
    try {
      const body = await readBody(req);
      const query = typeof body?.query === "string" ? body.query : "";
      const items = await webSearchLite(query);
      sendJson(res, 200, { ok: true, items }, origin);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { ok: false, error: "web_search_failed", message }, origin);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/fetch-url-text") {
    if (!checkApiKey(req, res, origin)) return;
    try {
      const body = await readBody(req);
      const raw = typeof body?.url === "string" ? body.url.trim() : "";
      if (!raw || !/^https?:\/\//i.test(raw)) {
        sendJson(res, 400, { ok: false, error: "invalid_url", message: "需要 http(s) 链接" }, origin);
        return;
      }
      const u = new URL(raw);
      if (!["http:", "https:"].includes(u.protocol)) {
        sendJson(res, 400, { ok: false, error: "invalid_protocol", message: "仅支持 http/https" }, origin);
        return;
      }
      const host = u.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.endsWith(".local")
      ) {
        sendJson(res, 400, { ok: false, error: "blocked_host", message: "禁止抓取本机与内网类地址" }, origin);
        return;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 22_000);
      const resFetch = await fetch(raw, {
        redirect: "follow",
        signal: ctrl.signal,
        headers: {
          "User-Agent": "FA-Workbench-KnowledgeLearn/1.0",
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        },
      });
      clearTimeout(timer);
      const ct = (resFetch.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const buf = Buffer.from(await resFetch.arrayBuffer());
      const maxBytes = 2 * 1024 * 1024;
      const slice = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
      let text = "";
      if (ct.includes("json")) {
        const s = slice.toString("utf8");
        try {
          text = JSON.stringify(JSON.parse(s));
        } catch {
          text = s;
        }
      } else {
        text = stripHtmlToPlainText(slice.toString("utf8"));
      }
      const maxChars = 400_000;
      if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…（已截断）`;
      sendJson(
        res,
        200,
        {
          ok: true,
          text,
          finalUrl: resFetch.url,
          contentType: ct,
          truncatedBytes: buf.length > maxBytes,
        },
        origin,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { ok: false, error: "fetch_url_failed", message }, origin);
    }
    return;
  }

  if (req.method === "POST" && pathname === "/api/search-feishu-docs") {
    if (!checkApiKey(req, res, origin)) return;
    try {
      const body = await readBody(req);
      const userAccessToken =
        typeof body?.userAccessToken === "string" ? body.userAccessToken.trim() : "";
      const query = typeof body?.query === "string" ? body.query : "";
      if (userAccessToken.length < 10) {
        sendJson(
          res,
          400,
          {
            ok: false,
            error: "missing_user_access_token",
            message: "请先完成飞书 OAuth 登录，提供 userAccessToken。",
          },
          origin,
        );
        return;
      }
      const { docs, searchError } = await collectDocWikiSearch(userAccessToken, query, {
        maxPages: body?.maxPages,
      });
      sendJson(
        res,
        200,
        {
          ok: true,
          total: docs.length,
          docs,
          searchWarning: searchError || undefined,
        },
        origin,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, 500, { ok: false, error: "search_feishu_docs_failed", message }, origin);
    }
    return;
  }

  if (req.method !== "POST" || pathname !== "/api/sync-feishu") {
    sendJson(
      res,
      404,
      {
        error: "not_found",
        method: req.method,
        path: pathname,
        hint:
          "若点击了「飞书授权」：请结束旧进程后重新执行 npm.cmd run sync-server，并确认 vite 代理端口指向本服务（默认 3789）。",
      },
      origin,
    );
    return;
  }

  if (!checkApiKey(req, res, origin)) return;

  if (!APP_ID || !APP_SECRET || !SPREADSHEET_TOKEN) {
    sendJson(
      res,
      500,
      { error: "missing_env", message: "请在项目根 .env 中配置 FEISHU_APP_ID、FEISHU_APP_SECRET、FEISHU_SPREADSHEET_TOKEN" },
      origin,
    );
    return;
  }

  let headerRowSnapshot = null;
  try {
    const body = await readBody(req);
    const rows = body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      sendJson(res, 400, { error: "invalid_body", message: "rows 必须为非空数组" }, origin);
      return;
    }

    const sheetName = body.sheetName || SHEET_TITLE;
    const payloadHeaders = Array.isArray(body.headers) && body.headers.length ? body.headers : null;
    const token = await getTenantToken();
    const sheets = await querySheets(token);
    const sheet = sheets.find((s) => s.title === sheetName && s.resource_type === "sheet");
    if (!sheet) {
      sendJson(res, 400, { error: "sheet_not_found", message: `未找到子表：${sheetName}` }, origin);
      return;
    }

    let headerRow = await readHeaderRow(token, sheet.sheet_id);
    if (!headerRow.length && payloadHeaders) {
      headerRow = normalizeHeaderRowFromFeishu(payloadHeaders.map(String));
    }
    if (!headerRow.length) {
      sendJson(res, 400, { error: "empty_header", message: "表格第 1 行为空且请求未带 headers，无法对齐列" }, origin);
      return;
    }
    headerRowSnapshot = headerRow.map((h) => (h == null ? "" : String(h).trim()));
    const valueRows = buildDataRows(headerRow, rows);
    const updates = await appendValues(token, sheet.sheet_id, headerRow, valueRows);

    sendJson(
      res,
      200,
      {
        ok: true,
        appended: valueRows.length,
        updatedRange: updates.updatedRange,
        updatedRows: updates.updatedRows,
      },
      origin,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const feishuResponse =
      e && typeof e === "object" && "feishuResponse" in e ? e.feishuResponse : undefined;
    const syncDbg = e && typeof e === "object" && "syncDebug" in e ? e.syncDebug : undefined;
    console.error("[sync-server] /api/sync-feishu 异常:", message);
    if (feishuResponse) console.error("[sync-server] feishuResponse:", JSON.stringify(feishuResponse, null, 2));
    const debug = {
      ...(syncDbg && typeof syncDbg === "object" ? syncDbg : {}),
    };
    if (headerRowSnapshot && headerRowSnapshot.length) {
      debug.headerColumnCount = headerRowSnapshot.length;
      debug.headerPreview = headerRowSnapshot.slice(0, 20);
      if (headerRowSnapshot.length > 20) debug.headerTruncated = true;
    }
    sendJson(
      res,
      500,
      {
        ok: false,
        error: "sync_failed",
        message,
        /** 飞书接口返回体（含 code/msg），与终端日志一致 */
        feishuResponse: feishuResponse ?? null,
        debug: Object.keys(debug).length ? debug : null,
      },
      origin,
    );
  }
});

server.on("error", (err) => {
  const e = err;
  if (e && typeof e === "object" && "code" in e && e.code === "EADDRINUSE") {
    console.error(`[sync-server] 端口 ${PORT} 已被占用（EADDRINUSE）。`);
    console.error(
      "[sync-server] 处理：① 若已开过本服务，直接用那个终端即可，不要重复启动；② 或结束占用进程后再启动；③ 或在 .env 设置 SERVER_PORT=3790，并同步把 vite.config.ts 里 proxy 的 3789 改成 3790。",
    );
    console.error(`[sync-server] 查占用 PID（PowerShell）：Get-NetTCPConnection -LocalPort ${PORT} -State Listen`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`[sync-server] http://127.0.0.1:${PORT}`);
  if (ENV_SOURCE) {
    console.log(`[sync-server] env source: ${ENV_SOURCE}`);
  } else {
    console.log("[sync-server] env source: process env only");
  }
  if (SPREADSHEET_TOKEN === "你的表格_token") {
    console.log("[sync-server] warning: FEISHU_SPREADSHEET_TOKEN 仍是占位符");
  }
  if (SYNC_API_KEY) {
    console.log("[sync-server] SYNC_API_KEY 已启用（请求需带 X-Api-Key 或 Authorization: Bearer）");
  } else {
    console.log("[sync-server] 提示：公网部署建议设置 SYNC_API_KEY，避免接口被任意调用");
  }
  console.log(`[sync-server] insertDataOption: ${INSERT_DATA_OPTION}`);
  console.log(
    "[sync-server] POST /api/sync-feishu  |  POST /api/fetch-feishu-doc  |  POST /api/fetch-url-text  |  POST /api/list-feishu-readable-docs  |  POST /api/web-search-lite",
  );
  if (OAUTH_REDIRECT_URI) {
    console.log("[sync-server] 飞书用户 OAuth 已配置：GET /api/auth/feishu/login → callback");
  }
});
