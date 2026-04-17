import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { feishuOAuthLoginHref } from "@/lib/feishuApi";
import {
  formatHistoryTime,
  readWorkbenchHistory,
  subscribeWorkbenchHistory,
  type WorkbenchHistoryEntry,
} from "@/lib/workbenchHistory";
import styles from "./Layout.module.css";
import {
  IconChart,
  IconClipboard,
  IconFileText,
  IconIntelFeed,
  IconLibrary,
  IconMessage,
} from "./icons/ModuleIcons";
import FeishuOAuthBridge from "./FeishuOAuthBridge";
import WorkbenchHelpBody from "./WorkbenchHelpBody";

const nav = [
  { to: "/", label: "总览", icon: IconChart },
  { to: "/registration", label: "信息登记", icon: IconClipboard },
  { to: "/report", label: "报告撰写", icon: IconFileText },
  { to: "/visualization", label: "数据分析", icon: IconChart },
  { to: "/qa", label: "知识问答", icon: IconMessage },
  { to: "/intel", label: "更多资讯", icon: IconIntelFeed },
  { to: "/knowledge", label: "知识库", icon: IconLibrary },
];

const panelByPath: Record<string, { title: string; lines: string[] }> = {
  "/": {
    title: "平台概览",
    lines: [
      "各模块如需读写飞书云文档/表格，请通过顶部「飞书登录」「帮助」完成授权与环境配置。本地开发可在项目根执行 npm.cmd run dev:all 同时启动同步服务与页面。",
      "各模块共用知识库底座，数据在登记、报告与问答之间保持一致口径。",
      "建议从「信息登记」建立 case，再进入报告与分析流程。",
    ],
  },
  "/registration": {
    title: "信息登记",
    lines: [
      "从文档链接抽取字段并同步至共享登记表，形成可追溯台账。",
      "飞书环境与授权说明见顶部「帮助」；同步地址与令牌见下方锚点区域。",
    ],
  },
  "/report": {
    title: "报告撰写",
    lines: [
      "按模板将 case 与证据填入章节，生成标准化 FA 报告草稿。",
      "可与登记表字段联动，减少重复录入。",
    ],
  },
  "/visualization": {
    title: "数据分析",
    lines: [
      "基于登记表汇总、筛选与可视化，查看批次与趋势。",
      "适合例会复盘与质量看板展示。",
    ],
  },
  "/qa": {
    title: "知识问答",
    lines: [
      "结合知识库与术语，支持流程与原理类检索。",
      "后续可接入向量检索以增强召回。",
    ],
  },
  "/intel": {
    title: "更多资讯",
    lines: [
      "从网络检索芯片失效分析相关公开资料，并可归档至知识库分类。",
      "请按需配置检索策略与同步频率。",
    ],
  },
  "/knowledge": {
    title: "知识库",
    lines: [
      "用文件夹组织链接与文档，构建可检索的企业知识底座。",
      "解析与向量化在接入后端后执行。",
    ],
  },
};

const defaultPanel = {
  title: "说明",
  lines: ["当前页面的辅助说明将显示在此。"],
};

const RECENT_KEY = "fa-workbench-recent-pages";
const RECENT_MAX = 6;

export default function Layout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const panel = panelByPath[location.pathname] ?? defaultPanel;
  const [searchText, setSearchText] = useState("");
  const [recentPages, setRecentPages] = useState<Array<{ to: string; label: string }>>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<WorkbenchHistoryEntry[]>(() => readWorkbenchHistory());
  const historyWrapRef = useRef<HTMLDivElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [feishuLoginOpen, setFeishuLoginOpen] = useState(false);

  const navMap = useMemo(() => new Map(nav.map((n) => [n.to, n.label])), []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<{ to: string; label: string }>;
      if (!Array.isArray(parsed)) return;
      setRecentPages(parsed.filter((x) => x && typeof x.to === "string" && typeof x.label === "string"));
    } catch {
      // ignore bad localStorage payload
    }
  }, []);

  useEffect(() => {
    const label = navMap.get(location.pathname);
    if (!label) return;
    setRecentPages((prev) => {
      const next = [{ to: location.pathname, label }, ...prev.filter((x) => x.to !== location.pathname)].slice(
        0,
        RECENT_MAX,
      );
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        // ignore quota or privacy mode errors
      }
      return next;
    });
  }, [location.pathname, navMap]);

  useEffect(() => {
    const refresh = () => setHistoryList(readWorkbenchHistory());
    refresh();
    return subscribeWorkbenchHistory(refresh);
  }, []);

  useEffect(() => {
    if (!historyOpen) return;
    function onDocClick(ev: MouseEvent) {
      const el = historyWrapRef.current;
      if (el && !el.contains(ev.target as Node)) setHistoryOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [historyOpen]);

  useEffect(() => {
    if (!helpOpen && !feishuLoginOpen) return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") {
        setHelpOpen(false);
        setFeishuLoginOpen(false);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [helpOpen, feishuLoginOpen]);

  function jumpBySearchInput() {
    const q = searchText.trim();
    if (!q) return;
    const hit = nav.find((item) => item.label.includes(q) || item.to === q);
    if (!hit) return;
    navigate(hit.to);
    setSearchText("");
  }

  function openHistoryEntry(entry: WorkbenchHistoryEntry) {
    if (entry.snapshot != null) {
      navigate(entry.path, { state: { faHistoryRestore: entry } });
    } else {
      navigate(entry.path);
    }
    setHistoryOpen(false);
  }

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="主导航">
        <div className={styles.sidebarTop}>
          <Link to="/" className={styles.brand}>
            <span className={styles.brandMark} aria-hidden />
            <span className={styles.brandText}>FA 工作台</span>
          </Link>
        </div>
        <nav className={styles.nav} aria-label="模块导航">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                [styles.navLink, isActive ? styles.navLinkActive : ""].join(" ")
              }
            >
              <item.icon className={styles.navIcon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className={styles.workspace}>
        <header className={styles.topBar} aria-label="快捷功能栏">
          <div className={styles.topBarLeft}>
            <h1 className={styles.topBarTitle}>FA 数据平台</h1>
            <span className={styles.topBarSub}>{panel.title}</span>
          </div>
          <div className={styles.topBarTools}>
            <button
              type="button"
              className={`${styles.cornerBtn} ${styles.cornerBtnPrimary}`}
              onClick={() => setFeishuLoginOpen(true)}
            >
              飞书登录
            </button>
            <button type="button" className={styles.cornerBtn} onClick={() => setHelpOpen(true)}>
              帮助
            </button>
            <div className={styles.searchWrap} aria-label="全局搜索">
              <input
                className={styles.searchInput}
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") jumpBySearchInput();
                }}
                placeholder="搜索模块，如：信息登记"
              />
              <button type="button" className={styles.searchBtn} onClick={jumpBySearchInput}>
                跳转
              </button>
            </div>
            <select
              className={styles.recentSelect}
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                navigate(e.target.value);
              }}
              aria-label="最近访问"
            >
              <option value="">最近访问</option>
              {recentPages.map((item) => (
                <option key={item.to} value={item.to}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className={styles.historyWrap} ref={historyWrapRef}>
              <button
                type="button"
                className={styles.historyBtn}
                aria-expanded={historyOpen}
                aria-haspopup="listbox"
                onClick={() => setHistoryOpen((o) => !o)}
              >
                历史记录
              </button>
              {historyOpen ? (
                <div className={styles.historyDropdown} role="listbox" aria-label="操作历史">
                  {historyList.length === 0 ? (
                    <p className={styles.historyEmpty}>暂无历史记录。在信息登记抽取、知识库维护等操作后会自动记录。</p>
                  ) : (
                    <ul className={styles.historyList}>
                      {historyList.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={styles.historyItem}
                            role="option"
                            onClick={() => openHistoryEntry(item)}
                          >
                            <span className={styles.historyItemTitle}>{item.title}</span>
                            <span className={styles.historyItemMeta}>
                              {item.moduleLabel} · {formatHistoryTime(item.ts)}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {helpOpen ? (
          <div
            className={styles.modalRoot}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-help-title"
            onClick={() => setHelpOpen(false)}
          >
            <div className={styles.modalPanel} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHead}>
                <h2 id="wb-help-title" className={styles.modalTitle}>
                  使用说明与注意事项
                </h2>
                <button type="button" className={styles.modalClose} aria-label="关闭" onClick={() => setHelpOpen(false)}>
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                <WorkbenchHelpBody />
              </div>
            </div>
          </div>
        ) : null}

        {feishuLoginOpen ? (
          <div
            className={styles.modalRoot}
            role="dialog"
            aria-modal="true"
            aria-labelledby="wb-feishu-login-title"
            onClick={() => setFeishuLoginOpen(false)}
          >
            <div className={`${styles.modalPanel} ${styles.modalPanelSm}`} onClick={(e) => e.stopPropagation()}>
              <div className={styles.modalHead}>
                <h2 id="wb-feishu-login-title" className={styles.modalTitle}>
                  飞书用户授权
                </h2>
                <button
                  type="button"
                  className={styles.modalClose}
                  aria-label="关闭"
                  onClick={() => setFeishuLoginOpen(false)}
                >
                  ×
                </button>
              </div>
              <div className={styles.modalBody}>
                <p className={styles.modalFeishuLead}>
                  以<strong>用户身份</strong>访问云文档、表格前，需先在飞书完成登录授权。将在<strong>新标签页</strong>打开飞书页面，请<strong>勿关闭本工作台标签页</strong>，以便授权完成后写回令牌。
                </p>
                <div className={styles.modalActions}>
                  <a
                    href={feishuOAuthLoginHref()}
                    target="_blank"
                    rel="opener"
                    className={styles.modalPrimaryLink}
                    onClick={() => setFeishuLoginOpen(false)}
                  >
                    打开飞书授权
                  </a>
                  <Link
                    to="/registration#workbench-feishu-settings"
                    className={styles.modalSecondaryLink}
                    onClick={() => setFeishuLoginOpen(false)}
                  >
                    去填写同步地址与令牌
                  </Link>
                </div>
                <p style={{ marginTop: "0.85rem", marginBottom: 0, fontSize: "0.78rem", color: "var(--muted)", lineHeight: 1.5 }}>
                  若未配置 <code>FEISHU_OAUTH_REDIRECT_URI</code> 等，请先查看「帮助」或 <code>.env.example</code>。
                </p>
                <p style={{ marginTop: "0.65rem", marginBottom: 0, fontSize: "0.76rem", color: "#b45309", lineHeight: 1.5 }}>
                  若授权后浏览器提示「无法访问此页面 / 连接被拒绝」：多为回跳地址指向了{" "}
                  <code>localhost:517x</code> 但此时 Vite 未运行。请把 <code>.env</code> 与飞书后台的重定向改为{" "}
                  <code>http://127.0.0.1:3789/api/auth/feishu/callback</code>（与 <code>SERVER_PORT</code> 一致），重启{" "}
                  <code>npm.cmd run sync-server</code> 后再试。
                </p>
                <div className={styles.modalFootBtn}>
                  <button type="button" className={styles.modalDismiss} onClick={() => setFeishuLoginOpen(false)}>
                    关闭
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <FeishuOAuthBridge />

        <div className={styles.contentRow}>
          <main className={styles.main}>{children}</main>
          <aside className={styles.detailPanel} aria-label="页面说明">
            <div className={styles.detailInner}>
              <h2 className={styles.detailTitle}>{panel.title}</h2>
              {panel.lines.map((line) => (
                <p key={line} className={styles.detailText}>
                  {line}
                </p>
              ))}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
