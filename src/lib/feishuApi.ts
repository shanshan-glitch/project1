const FEISHU_API_BASE = (import.meta.env.VITE_FEISHU_API_BASE ?? "").replace(/\/$/, "");

/** 本地开发：相对路径走 Vite 代理；线上构建：设置 VITE_FEISHU_API_BASE 指向已部署的 sync-server 根地址（无尾斜杠） */
export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return FEISHU_API_BASE ? `${FEISHU_API_BASE}${p}` : p;
}

/** 飞书 OAuth 登录页（新标签打开时请使用 rel="opener" 以便回调 postMessage） */
export function feishuOAuthLoginHref(): string {
  if (typeof window === "undefined") return "#";
  return apiUrl(`/api/auth/feishu/login?next_origin=${encodeURIComponent(window.location.origin)}`);
}

/** 调用本机 / 部署的 sync-server 上受保护的接口时使用 */
export function syncApiHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  const k = (import.meta.env.VITE_SYNC_API_KEY ?? "").trim();
  if (k) h["X-Api-Key"] = k;
  return h;
}
