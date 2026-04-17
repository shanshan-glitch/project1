import { Link } from "react-router-dom";
import { apiUrl } from "@/lib/feishuApi";
import styles from "./WorkbenchHelpBody.module.css";

export default function WorkbenchHelpBody() {
  const defaultSync = apiUrl("/api/sync-feishu");

  return (
    <>
      <p className={styles.intro}>
        各模块如需读取或编辑飞书云文档、表格，共用同一套本地同步服务与开放平台权限。建议先完成下列配置，避免拉取正文或写入表格时出现权限、网络类错误。
      </p>
      <ol className={styles.list}>
        <li>
          <strong>运行本地服务</strong>（二选一）。<strong>推荐</strong>：在项目根执行{" "}
          <code style={{ fontSize: "0.76rem" }}>npm.cmd run dev:all</code>
          ，一条命令同时启动 sync-server 与 Vite（PowerShell 请用 <code>npm.cmd</code>，避免脚本策略拦截）；保持该终端不关，在浏览器打开终端里打印的本地地址（如{" "}
          <code>http://localhost:5173/</code>）。<strong>或</strong>分两个终端：先{" "}
          <code style={{ fontSize: "0.76rem" }}>npm.cmd run sync-server</code>，再{" "}
          <code style={{ fontSize: "0.76rem" }}>npm.cmd run dev</code>。
        </li>
        <li>
          <strong>同步服务地址</strong>：在「信息登记」页填写「同步服务地址」。本地使用 <code>dev:all</code> 或 <code>dev</code> 时一般为{" "}
          <code style={{ fontSize: "0.76rem" }}>{defaultSync}</code>（Vite 将 <code>/api</code> 代理到本机 sync-server；线上需设置{" "}
          <code>VITE_FEISHU_API_BASE</code>）。
        </li>
        <li>
          <strong>飞书用户授权（按需）</strong>：以<strong>用户身份</strong>访问云文档、减少「逐篇添加应用」时，需在开放平台申请<strong>用户身份</strong>相关权限，并在项目{" "}
          <code>.env</code> 中配置 <code>FEISHU_OAUTH_REDIRECT_URI</code>、<code>FEISHU_OAUTH_SCOPE</code> 后，通过顶部「飞书登录」在新标签页完成授权（勿关闭工作台标签页）。本地强烈建议重定向 URL 使用{" "}
          <code>http://127.0.0.1:3789/api/auth/feishu/callback</code>（直连 sync-server），避免回跳到{" "}
          <code>localhost:517x</code> 时因 Vite 未启动或端口变化出现「无法访问此页面」。
        </li>
        <li>
          <strong>开放平台</strong>：在飞书开发者后台申请并<strong>发布</strong>所需 API 权限；修改权限或 scope 后需重新授权以更换 token。
        </li>
      </ol>
      <p className={styles.note}>
        常见错误：PowerShell 请使用 <code>npm.cmd</code>；OAuth 回调地址须与控制台「重定向 URL」完全一致；拉 docx 需在 scope 中包含{" "}
        <code>docx:document:readonly</code> 等已开通权限。更多变量说明见项目根目录 <code>.env.example</code>。
      </p>
      <div className={styles.links}>
        <Link to="/registration#workbench-feishu-settings" className={styles.regLink}>
          前往信息登记：同步地址与用户令牌 →
        </Link>
      </div>
    </>
  );
}
