const DB_NAME = "fa-workbench-knowledge-learned-text";
const STORE_NAME = "texts";
const DB_VERSION = 1;

export const MAX_LEARNED_TEXT_CHARS = 400_000;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB 打开失败"));
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function putLearnedText(id: string, text: string): Promise<void> {
  const trimmed = text.length > MAX_LEARNED_TEXT_CHARS ? `${text.slice(0, MAX_LEARNED_TEXT_CHARS)}\n…（已截断）` : text;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 写入失败"));
    tx.objectStore(STORE_NAME).put(trimmed, id);
  });
}

export async function getLearnedText(id: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 读取失败"));
    const r = tx.objectStore(STORE_NAME).get(id);
    r.onerror = () => reject(r.error ?? new Error("读取失败"));
    r.onsuccess = () => {
      const v = r.result;
      resolve(typeof v === "string" && v.length > 0 ? v : null);
    };
  });
}

/** 并行读取多条，失败项视为无文本 */
export async function getLearnedTextsForIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await Promise.all(
    ids.map(async (raw) => {
      const id = String(raw);
      try {
        const t = await getLearnedText(id);
        if (t) out.set(id, t);
      } catch {
        /* ignore */
      }
    }),
  );
  return out;
}

export async function deleteLearnedText(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 删除失败"));
    tx.objectStore(STORE_NAME).delete(id);
  });
}
