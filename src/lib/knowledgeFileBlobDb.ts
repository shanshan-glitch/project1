const DB_NAME = "fa-workbench-knowledge-blobs";
const STORE_NAME = "files";
const DB_VERSION = 1;

export type KnowledgeStoredBlob = {
  name: string;
  mime: string;
  data: ArrayBuffer;
};

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

export async function putKnowledgeFileBlob(id: string, payload: KnowledgeStoredBlob): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务中止"));
    tx.objectStore(STORE_NAME).put(payload, id);
  });
}

export async function getKnowledgeFileBlob(id: string): Promise<KnowledgeStoredBlob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 读取失败"));
    const r = tx.objectStore(STORE_NAME).get(id);
    r.onerror = () => reject(r.error ?? new Error("读取失败"));
    r.onsuccess = () => {
      const v = r.result;
      if (!v || typeof v !== "object") {
        resolve(null);
        return;
      }
      const o = v as Record<string, unknown>;
      if (typeof o.name !== "string" || typeof o.mime !== "string" || !(o.data instanceof ArrayBuffer)) {
        resolve(null);
        return;
      }
      resolve({ name: o.name, mime: o.mime, data: o.data });
    };
  });
}

export async function deleteKnowledgeFileBlob(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 删除失败"));
    tx.objectStore(STORE_NAME).delete(id);
  });
}
