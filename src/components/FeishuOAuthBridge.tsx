import { useEffect } from "react";

/**
 * 无 UI：监听飞书 OAuth 回调页的 postMessage，写入令牌并广播，供各页（如信息登记）同步状态。
 */
export default function FeishuOAuthBridge() {
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      const data = ev.data as { source?: string; ok?: boolean; access_token?: string; refresh_token?: string };
      if (!data || data.source !== "feishu-oauth") return;
      if (data.ok && typeof data.access_token === "string" && data.access_token.trim()) {
        try {
          localStorage.setItem("fa-user-access-token", data.access_token.trim());
          if (typeof data.refresh_token === "string" && data.refresh_token.trim()) {
            localStorage.setItem("fa-feishu-refresh-token", data.refresh_token.trim());
          }
        } catch {
          /* ignore */
        }
        window.dispatchEvent(new Event("fa-user-access-token-updated"));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return null;
}
