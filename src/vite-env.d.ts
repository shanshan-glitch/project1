/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 公网部署时填后端根地址（无尾斜杠），如 https://your-api.example.com；本地留空则用 Vite 代理 */
  readonly VITE_FEISHU_API_BASE?: string;
  /** 若服务端设置了 SYNC_API_KEY，此处填相同值（会打进前端包，仅作简易防刷） */
  readonly VITE_SYNC_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
