import * as pdfjsLib from "pdfjs-dist";
// Vite：worker 独立 chunk，避免主线程 bundle 过大
import pdfWorkerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

const MAX_PDF_PAGES = 80;

let workerConfigured = false;

function ensurePdfWorker() {
  if (workerConfigured) return;
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc;
  workerConfigured = true;
}

/**
 * 从 PDF ArrayBuffer 抽取纯文本（最多前 MAX_PDF_PAGES 页），供知识库学习与问答检索。
 */
export async function extractPdfTextFromArrayBuffer(data: ArrayBuffer): Promise<string> {
  ensurePdfWorker();
  const u8 = data.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(data);
  const loadingTask = pdfjsLib.getDocument({ data: u8, useSystemFonts: true }).promise;
  const pdf = await loadingTask;
  const parts: string[] = [];
  const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
  for (let i = 1; i <= n; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => {
        if (item && typeof item === "object" && "str" in item && typeof (item as { str?: string }).str === "string") {
          return (item as { str: string }).str;
        }
        return "";
      })
      .join(" ");
    parts.push(line);
  }
  if (pdf.numPages > MAX_PDF_PAGES) {
    parts.push(`\n…（仅抽取前 ${MAX_PDF_PAGES} 页，共 ${pdf.numPages} 页）`);
  }
  let text = parts.join("\n").replace(/\s+/g, " ").trim();
  const maxChars = 400_000;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}\n…（已截断）`;
  }
  return text;
}
