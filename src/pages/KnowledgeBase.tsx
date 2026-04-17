import { useId, useMemo, useState } from "react";
import { useFaHistoryRestore } from "@/hooks/useFaHistoryRestore";
import { appendWorkbenchHistory } from "@/lib/workbenchHistory";
import page from "./Page.module.css";
import styles from "./KnowledgeBase.module.css";

type Folder = { id: string; name: string };
type LinkEntry = { id: string; folderId: string; url: string; addedAt: string };

type KnowledgeHistorySnapshot = {
  module: "knowledge";
  v: 1;
  folders: Folder[];
  entries: LinkEntry[];
  selectedFolderId: string | null;
  newFolderName: string;
  linkUrl: string;
};

function isKnowledgeSnapshot(s: unknown): s is KnowledgeHistorySnapshot {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  return o.module === "knowledge" && o.v === 1 && Array.isArray(o.folders) && Array.isArray(o.entries);
}

function knowledgeSnapshot(p: Omit<KnowledgeHistorySnapshot, "module" | "v">): KnowledgeHistorySnapshot {
  return { module: "knowledge", v: 1, ...p };
}

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export default function KnowledgeBase() {
  const baseId = useId();
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [entries, setEntries] = useState<LinkEntry[]>([]);

  useFaHistoryRestore("/knowledge", (snap) => {
    if (!isKnowledgeSnapshot(snap)) return;
    setFolders(snap.folders);
    setEntries(snap.entries);
    setSelectedFolderId(snap.selectedFolderId);
    setNewFolderName(snap.newFolderName);
    setLinkUrl(snap.linkUrl);
  }, isKnowledgeSnapshot);

  const selectedFolder = useMemo(
    () => folders.find((f) => f.id === selectedFolderId) ?? null,
    [folders, selectedFolderId],
  );

  const folderEntries = useMemo(
    () => entries.filter((e) => e.folderId === selectedFolderId),
    [entries, selectedFolderId],
  );

  function addFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    const id = makeId();
    const nextFolders = [...folders, { id, name }];
    setFolders(nextFolders);
    setSelectedFolderId(id);
    setNewFolderName("");
    appendWorkbenchHistory({
      path: "/knowledge",
      moduleLabel: "知识库",
      title: `新建文件夹：${name}`,
      snapshot: knowledgeSnapshot({
        folders: nextFolders,
        entries,
        selectedFolderId: id,
        newFolderName: "",
        linkUrl,
      }),
    });
  }

  function removeFolder(id: string) {
    setFolders((prev) => prev.filter((f) => f.id !== id));
    setEntries((prev) => prev.filter((e) => e.folderId !== id));
    setSelectedFolderId((cur) => (cur === id ? null : cur));
  }

  function addLinkToLearn() {
    if (!selectedFolderId || !linkUrl.trim()) return;
    let url = linkUrl.trim();
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const entry: LinkEntry = {
      id: makeId(),
      folderId: selectedFolderId,
      url,
      addedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
    const nextEntries = [...entries, entry];
    setEntries(nextEntries);
    setLinkUrl("");
    appendWorkbenchHistory({
      path: "/knowledge",
      moduleLabel: "知识库",
      title: `添加链接：${url.length > 42 ? `${url.slice(0, 42)}…` : url}`,
      snapshot: knowledgeSnapshot({
        folders,
        entries: nextEntries,
        selectedFolderId,
        newFolderName,
        linkUrl: "",
      }),
    });
  }

  return (
    <div>
      <h1 className={page.pageTitle}>知识库</h1>
      <p className={page.pageDesc}>
        通过文档或网页链接让系统学习内容；请先建立文件夹对知识分类，再将链接归入对应分类（解析与向量化在接入后端后执行）。
      </p>

      <div className={styles.layout}>
        <aside className={styles.sidebar} aria-label="知识分类">
          <div className={styles.sidebarHead}>
            <span className={styles.sidebarTitle}>文件夹</span>
          </div>
          <div className={styles.newFolder}>
            <input
              id={`${baseId}-folder-name`}
              className={page.input}
              placeholder="新建文件夹名称"
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
                    <span className={styles.folderName}>{f.name}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.folderDelete}
                    title="删除文件夹"
                    aria-label={`删除文件夹 ${f.name}`}
                    onClick={() => removeFolder(f.id)}
                  >
                    ×
                  </button>
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
                分类确定后，即可在下方粘贴链接并加入学习队列。
              </p>
            </div>
          ) : (
            <>
              <p className={styles.context}>
                当前分类：<strong>{selectedFolder.name}</strong>
              </p>
              <label className={page.label} htmlFor={`${baseId}-url`}>
                文档或网页链接
              </label>
              <input
                id={`${baseId}-url`}
                className={page.input}
                type="url"
                inputMode="url"
                placeholder="https://..."
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addLinkToLearn()}
              />
              <div className={styles.linkActions}>
                <button
                  type="button"
                  className={`${page.btn} ${page.btnPrimary}`}
                  onClick={addLinkToLearn}
                  disabled={!linkUrl.trim()}
                >
                  加入学习队列
                </button>
              </div>
              <p className={page.note} style={{ marginTop: "1rem" }}>
                接入后端后，将对链接做抓取、清洗与向量化，并仅归属于当前文件夹；重复链接可去重合并。
              </p>

              {folderEntries.length > 0 && (
                <div className={styles.queue}>
                  <h2 className={styles.queueTitle}>本分类已加入的链接</h2>
                  <ul className={styles.queueList}>
                    {folderEntries.map((e) => (
                      <li key={e.id} className={styles.queueItem}>
                        <a href={e.url} target="_blank" rel="noopener noreferrer" className={styles.queueLink}>
                          {e.url}
                        </a>
                        <span className={styles.queueMeta}>{e.addedAt} · 待解析</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
