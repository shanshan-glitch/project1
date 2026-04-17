import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    /**
     * 监听 0.0.0.0，避免仅绑定 IPv4 时浏览器用 localhost 解析到 ::1 导致连接被拒绝。
     * OAuth 回调仍建议用 .env 中「直连 sync-server 端口」的重定向 URL（见 .env.example），不依赖本 dev 端口是否存活。
     */
    host: true,
    /** 开发时把 /api 转到本机 sync-server，网页只需相对路径即可联调 */
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3789",
        changeOrigin: true,
      },
    },
  },
});
