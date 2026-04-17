/** 跨模块操作历史：仅存于本机 localStorage */

export const WORKBENCH_HISTORY_KEY = "fa-workbench-operation-history";
export const WORKBENCH_HISTORY_EVENT = "fa-workbench-history-updated";

const MAX_ENTRIES = 50;

export type WorkbenchHistoryEntry = {
  id: string;
  ts: number;
  path: string;
  moduleLabel: string;
  title: string;
  /** 各模块自行约定结构；null 表示仅记录访问位置 */
  snapshot: unknown | null;
};

function newId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function readWorkbenchHistory(): WorkbenchHistoryEntry[] {
  try {
    const raw = localStorage.getItem(WORKBENCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is WorkbenchHistoryEntry =>
          x &&
          typeof x === "object" &&
          typeof (x as WorkbenchHistoryEntry).id === "string" &&
          typeof (x as WorkbenchHistoryEntry).path === "string" &&
          typeof (x as WorkbenchHistoryEntry).title === "string" &&
          typeof (x as WorkbenchHistoryEntry).ts === "number",
      )
      .map((x) => ({
        ...x,
        moduleLabel: typeof x.moduleLabel === "string" ? x.moduleLabel : "",
        snapshot: "snapshot" in x ? (x as WorkbenchHistoryEntry).snapshot : null,
      }));
  } catch {
    return [];
  }
}

function snapshotStorable(snapshot: unknown | null): unknown | null {
  if (snapshot == null) return null;
  try {
    return JSON.parse(JSON.stringify(snapshot)) as unknown;
  } catch {
    return null;
  }
}

export function appendWorkbenchHistory(
  partial: Omit<WorkbenchHistoryEntry, "id" | "ts"> & { id?: string },
): WorkbenchHistoryEntry {
  const entry: WorkbenchHistoryEntry = {
    id: partial.id ?? newId(),
    ts: Date.now(),
    path: partial.path,
    moduleLabel: partial.moduleLabel,
    title: partial.title,
    snapshot: snapshotStorable(partial.snapshot ?? null),
  };
  const prev = readWorkbenchHistory();
  const next = [entry, ...prev.filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(WORKBENCH_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // quota exceeded — drop oldest
    try {
      localStorage.setItem(WORKBENCH_HISTORY_KEY, JSON.stringify(next.slice(0, Math.floor(MAX_ENTRIES / 2))));
    } catch {
      // ignore
    }
  }
  window.dispatchEvent(new CustomEvent(WORKBENCH_HISTORY_EVENT));
  return entry;
}

export function subscribeWorkbenchHistory(handler: () => void) {
  window.addEventListener(WORKBENCH_HISTORY_EVENT, handler);
  return () => window.removeEventListener(WORKBENCH_HISTORY_EVENT, handler);
}

export function formatHistoryTime(ts: number) {
  try {
    return new Date(ts).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}
