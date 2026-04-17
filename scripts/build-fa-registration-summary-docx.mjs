/**
 * 生成 FA 信息登记相关「问题与调试汇总」Word 文档（.docx）。
 * 运行：npm.cmd run doc:fa-summary
 */
import { Document, HeadingLevel, Packer, Paragraph } from "docx";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "docs");
const outFile = path.join(outDir, "FA信息登记-问题与调试汇总.docx");

function h1(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
}

function h2(text) {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
}

function body(text) {
  return new Paragraph({ text });
}

function blank() {
  return new Paragraph({ text: "" });
}

const lines = [
  h1("FA 信息登记：开发与调试问题汇总"),
  body(`生成说明：由项目脚本自动生成；涵盖批量粘贴 → 拉取 docx/正文 → 抽取 → 同步飞书表相关事项。生成时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`),
  blank(),

  h1("一、架构与运行前提"),
  h2("1.1 浏览器无法直接读飞书云文档"),
  body("问题：登记页无法单靠浏览器拿到飞书 docx 正文。"),
  body("原因：需通过开放平台 API，且涉及密钥与跨域，不能由前端直连完成读云文档。"),
  body("处理：必须运行 sync-server；登记页调用 /api/fetch-feishu-doc，由服务端换 token 并请求飞书。"),
  body("调试：确认本机已 npm.cmd run sync-server；Network 中该 POST 是否 200 及响应体 ok/text。"),
  blank(),

  h2("1.2 开发环境 /api 代理"),
  body("问题：前端用相对路径 /api/... 却请求不到服务。"),
  body("原因：Vite 需将 /api 代理到 sync-server（默认 127.0.0.1:3789）。"),
  body("处理：检查 vite.config.ts 中 proxy；.env 的 SERVER_PORT 与代理目标端口一致。"),
  body("调试：502/503/504 多为后端未启动或端口错误；对比终端打印的监听端口。"),
  blank(),

  h1("二、Windows 与本地命令"),
  h2("2.1 PowerShell 禁止执行 npm.ps1"),
  body("问题：执行 npm run sync-server 提示无法加载 npm.ps1、脚本被禁止。"),
  body("原因：PowerShell ExecutionPolicy 限制 .ps1。"),
  body("处理：使用 npm.cmd run sync-server、npm.cmd run dev；或 Set-ExecutionPolicy RemoteSigned -Scope CurrentUser。"),
  blank(),

  h1("三、飞书表格同步（/api/sync-feishu）"),
  h2("3.1 90202 / RangeVal / 表头列数过大"),
  body("问题：values_append 报 90202、validate RangeVal 等。"),
  body("原因：读表头区间与 append 列区间不一致；A1:ZZ1 含大量尾随空列导致逻辑列数达数百。"),
  body("处理：服务端裁剪尾部空列并按 FEISHU_MAX_SYNC_COLUMNS 截断；表头读取与写入列数严格对齐。"),
  body("调试：查看终端 [sync-server] Feishu values_append 失败 的 JSON；对照飞书 code/msg。"),
  blank(),

  h2("3.2 单选/下拉列"),
  body("问题：下拉列写入格式不对或校验失败。"),
  body("原因：飞书需 multipleValue 结构，且选项文案须与表格下拉选项完全一致。"),
  body("处理：配置 FEISHU_DROPDOWN_HEADERS（与第 1 行表头一致）；写入值与选项文案一致。"),
  blank(),

  h2("3.3 追加策略 FEISHU_INSERT_DATA_OPTION"),
  body("问题：希望写入空行继承验证，或希望先插新行。"),
  body("处理：OVERWRITE（默认）或 INSERT_ROWS，在 .env 中切换对比。"),
  blank(),

  h2("3.4 文档链接列显示为可点链接"),
  body("处理：同步时对文档链接使用 type:url（含 text、link）写入单元格。"),
  blank(),

  h1("四、拉取云文档正文（/api/fetch-feishu-doc）"),
  h2("4.1 链接形态"),
  body("问题：部分链接无法拉正文。"),
  body("原因：当前仅解析路径含 /docx/ 的新版文档；wiki 等需用户粘贴正文。"),
  body("调试：非 docx 若走浏览器 fetch 易 CORS；改 docx 链接或粘贴全文。"),
  blank(),

  h2("4.2 应用身份 vs 用户身份"),
  body("问题：tenant 读不到、需逐篇在文档里添加应用。"),
  body("处理：使用 user_access_token（手动粘贴或 OAuth「飞书授权」），按用户权限读文档。"),
  blank(),

  h2("4.3 OAuth token 形态（JWT）"),
  body("问题：授权后仍走应用身份或拉取失败。"),
  body("原因：OAuth 返回的 access_token 多为 JWT（eyJ…），不是仅 u- 前缀。"),
  body("处理：服务端对非空且足够长度的 userAccessToken 即使用户态。"),
  blank(),

  h2("4.4 错误 99991679（docx:document / readonly）"),
  body("问题：接口返回 99991679，提示缺少用户身份权限 docx:document 或 docx:document:readonly。"),
  body("原因：开放平台未开通/未发布对应用户权限，或 OAuth scope 未包含、token 为旧授权。"),
  body("处理：在权限管理开通并发布上述权限之一；.env 中 FEISHU_OAUTH_SCOPE 空格分隔写入所需 scope；重新飞书授权换新 token。"),
  body("调试：响应体 permission_violations；官方文档：如何解决 99991679（飞书开放平台）。"),
  blank(),

  h1("五、用户 OAuth（飞书授权）"),
  h2("5.1 弹窗显示 {\"error\":\"not_found\"}"),
  body("原因：多为 sync-server 仍为旧进程，无 /api/auth/feishu/login 路由。"),
  body("处理：结束旧进程后重新 npm.cmd run sync-server。"),
  blank(),

  h2("5.2 req.url 与路由匹配"),
  body("原因：少数代理下路径非标准，仅用 req.url 前缀匹配可能 404。"),
  body("处理：服务端用 parseIncomingUrl 取 pathname；404 体含 path、hint 便于排查。"),
  blank(),

  h2("5.3 FEISHU_OAUTH_REDIRECT_URI"),
  body("含义：授权完成后飞书浏览器跳转的回调地址，须与开放平台「重定向 URL」完全一致。"),
  body("示例：http://127.0.0.1:5173/api/auth/feishu/callback（端口、主机与浏览器打开登记页时一致；localhost 与 127.0.0.1 勿混用）。"),
  blank(),

  h2("5.4 postMessage 收不到 token"),
  body("原因：window.open 使用 noopener 会断开 opener。"),
  body("处理：弹窗参数勿加 noopener。"),
  blank(),

  h2("5.5 scope 与 20027 等"),
  body("原因：FEISHU_OAUTH_SCOPE 超出应用已开通权限子集会报错。"),
  body("处理：缩小 scope 为已发布权限子集。"),
  blank(),

  h1("六、环境与安全"),
  h2("6.1 SYNC_API_KEY"),
  body("可选：限制 POST /api/sync-feishu 与 /api/fetch-feishu-doc；前端 VITE_SYNC_API_KEY 与之一致（密钥仍在浏览器可见）。"),
  blank(),

  h2("6.2 端口占用 EADDRINUSE"),
  body("处理：改 SERVER_PORT 并同步修改 Vite proxy；PowerShell：Get-NetTCPConnection -LocalPort <端口> -State Listen。"),
  blank(),

  h2("6.3 .env 位置"),
  body("须与 package.json 同级；服务端会尝试加载 .env 与 .env.example。"),
  blank(),

  h1("七、登记页调试顺序（建议）"),
  body("1）运行 sync-server 的终端：是否有 Feishu JSON 报错。"),
  body("2）浏览器 Network：/api/fetch-feishu-doc、/api/sync-feishu 的 status 与 response。"),
  body("3）页面「飞书接口返回」区域：feishuResponse、debug、serverMessage。"),
  body("4）抽取失败：状态行中「原因：」后的 error 文案（常含飞书 code/msg）。"),
  body("5）用户态：确认响应或日志中 authMode 为 user；99991679 按第四节处理权限与重新授权。"),
  blank(),

  h1("八、相关代码路径"),
  body("server/sync-server.mjs — 同步、拉 docx、OAuth 路由、环境变量。"),
  body("src/pages/Registration.tsx — 登记 UI、抽取、错误展示、授权弹窗。"),
  body("vite.config.ts — /api 代理。"),
  body(".env.example — 配置说明与示例。"),
];

mkdirSync(outDir, { recursive: true });

const doc = new Document({
  title: "FA信息登记-问题与调试汇总",
  description: "FA 工作台信息登记模块问题与调试汇总",
  sections: [{ children: lines }],
});

const buf = await Packer.toBuffer(doc);
writeFileSync(outFile, buf);
console.log(`[doc] 已写入：${outFile}`);
