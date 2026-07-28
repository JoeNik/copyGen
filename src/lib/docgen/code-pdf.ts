import { selectCodeLines } from "@/lib/utils";
import { escapeHTML, renderPagesToPDF } from "@/lib/docgen/pdf-render";

/** Keep under real content box; long wrapped lines cost extra. */
const LINES_PER_PAGE = 46;

function compressLines(lines: string[]): string[] {
  const result: string[] = [];
  let emptyCount = 0;
  for (const line of lines) {
    if (line.trim() === "") {
      emptyCount++;
      if (emptyCount <= 2) result.push(line);
    } else {
      emptyCount = 0;
      result.push(line);
    }
  }
  return result;
}

/** Visual rows after wrap (~88 monospace cols in content width). */
function visualLineCount(text: string, cols = 88): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(Math.max(text.length, 1) / cols));
}

export async function generateCodePDF(
  softwareName: string,
  version: string,
  codeFiles: { path: string; content: string }[],
  onProgress?: (msg: string) => void
): Promise<Blob> {
  const allLines: string[] = [];
  for (const file of codeFiles) {
    allLines.push(`// ========== 文件路径：${file.path} ==========`);
    allLines.push(...file.content.split("\n"));
    allLines.push("");
  }

  const selectedLines = selectCodeLines(allLines);
  const compressed = compressLines(selectedLines);

  const pages: string[] = [];
  let buf: string[] = [];
  let used = 0;

  const flush = () => {
    if (!buf.length) return;
    pages.push(buf.map((l) => `<div class="code-line">${escapeHTML(l) || " "}</div>`).join(""));
    buf = [];
    used = 0;
  };

  for (const line of compressed) {
    const cost = visualLineCount(line);
    if (used > 0 && used + cost > LINES_PER_PAGE) flush();
    // Extremely long single line: still place alone (may wrap within page)
    buf.push(line);
    used += cost;
    if (used >= LINES_PER_PAGE) flush();
  }
  flush();

  onProgress?.(`正在高清渲染程序鉴别材料（${pages.length} 页）...`);
  return renderPagesToPDF(pages, {
    headerText: `${softwareName} ${version}`,
    scale: 2,
    jpegQuality: 0.92,
    extraCSS: `.code-line{white-space:pre-wrap;word-break:break-all;min-height:14pt;font-family:'Noto Sans Mono','Courier New',monospace;font-size:9pt;line-height:14pt}`,
    onProgress: (done, total) => onProgress?.(`渲染程序 PDF ${done}/${total}...`),
  });
}
