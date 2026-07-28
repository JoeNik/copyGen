import { getFontCSS, injectFontsIntoHTML } from "@/lib/docgen/font-cache";

/** A4 at 96dpi CSS pixels */
export const PAGE_WIDTH_PX = 794;
export const PAGE_HEIGHT_PX = 1123;

/** Content box inside page (matches padding used in page CSS) */
export const PAGE_PAD_TOP = 72;
export const PAGE_PAD_BOTTOM = 56;
export const PAGE_PAD_X = 72;
/** Usable content height under the header line */
export const CONTENT_HEIGHT_PX = PAGE_HEIGHT_PX - PAGE_PAD_TOP - PAGE_PAD_BOTTOM - 28;

export function escapeHTML(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pageShellCSS(extra = ""): string {
  return `
*{margin:0;padding:0;box-sizing:border-box}
body{
  font-family:'Noto Sans SC','Microsoft YaHei','PingFang SC',sans-serif;
  font-size:10.5pt;line-height:1.7;color:#000;
  width:${PAGE_WIDTH_PX}px;height:${PAGE_HEIGHT_PX}px;
  padding:${PAGE_PAD_TOP}px ${PAGE_PAD_X}px ${PAGE_PAD_BOTTOM}px;
  overflow:hidden;background:#fff;
}
.header{
  display:flex;justify-content:space-between;align-items:center;
  font-size:9pt;margin-bottom:10px;padding-bottom:6px;
  border-bottom:0.5pt solid #000;color:#222;
}
.page-content{overflow:hidden}
h1{font-size:14pt;font-weight:700;margin:14pt 0 8pt;line-height:1.4;page-break-after:avoid}
h2{font-size:12pt;font-weight:700;margin:10pt 0 6pt;line-height:1.4}
h3{font-size:11pt;font-weight:700;margin:8pt 0 4pt}
p{text-indent:2em;margin:3pt 0;line-height:1.75;word-break:break-word}
ul,ol{margin:4pt 0 4pt 1.6em;padding:0}
li{margin:2pt 0;line-height:1.7}
pre{
  font-family:'Noto Sans Mono','Courier New',monospace;
  font-size:9pt;line-height:1.45;background:#f5f5f5;
  padding:6pt 8pt;margin:6pt 0;white-space:pre-wrap;word-break:break-all;
  border:0.5pt solid #ddd;
}
.code-line{
  white-space:pre-wrap;word-break:break-all;
  min-height:14pt;font-family:'Noto Sans Mono','Courier New',monospace;
  font-size:9pt;line-height:14pt;
}
.fig-placeholder{
  text-align:center;margin:10pt 0;padding:14pt 10pt;
  border:1px dashed #999;color:#666;font-style:italic;font-size:9.5pt;
}
.cover{text-align:center;padding-top:180pt}
.cover h1{font-size:22pt;margin-bottom:16pt;text-indent:0}
.cover .subtitle{font-size:16pt;margin-bottom:12pt}
.cover .meta{font-size:12pt;margin-bottom:8pt;color:#333}
.toc-title{text-align:center;font-size:14pt;font-weight:700;margin:8pt 0 18pt;text-indent:0}
.toc-item{text-indent:0;font-size:11pt;margin:0 0 8pt;line-height:1.6}
${extra}
`;
}

function buildPageHTML(contentHTML: string, headerText: string, pageNo: number, fontCSS: string, extraCSS = ""): string {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${pageShellCSS(extraCSS)}</style>
</head><body>
<div class="header"><span>${escapeHTML(headerText)}</span><span>第 ${pageNo} 页</span></div>
<div class="page-content">${contentHTML}</div>
</body></html>`;
  return injectFontsIntoHTML(html, fontCSS);
}

async function measureBlocks(blockHTMLs: string[], fontCSS: string, extraCSS = ""): Promise<number[]> {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${PAGE_WIDTH_PX}px;height:${PAGE_HEIGHT_PX}px;opacity:0;pointer-events:none;border:0;`;
  document.body.appendChild(iframe);
  try {
    const doc = iframe.contentDocument!;
    const measureHTML = injectFontsIntoHTML(
      `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>${pageShellCSS(extraCSS)}
body{height:auto;overflow:visible;padding:${PAGE_PAD_TOP}px ${PAGE_PAD_X}px ${PAGE_PAD_BOTTOM}px}
.measure-root{width:100%}
.measure-item{display:block}
</style></head><body><div class="measure-root" id="root"></div></body></html>`,
      fontCSS
    );
    doc.open();
    doc.write(measureHTML);
    doc.close();
    await iframe.contentWindow!.document.fonts.ready;
    await new Promise((r) => setTimeout(r, 80));

    const root = doc.getElementById("root")!;
    const heights: number[] = [];
    for (const block of blockHTMLs) {
      const wrap = doc.createElement("div");
      wrap.className = "measure-item";
      wrap.innerHTML = block;
      root.appendChild(wrap);
      // offsetHeight includes margins collapse quirks — use getBoundingClientRect
      const h = Math.ceil(wrap.getBoundingClientRect().height);
      heights.push(Math.max(h, 1));
      root.removeChild(wrap);
    }
    return heights;
  } finally {
    document.body.removeChild(iframe);
  }
}

/**
 * Pack HTML blocks into pages by measured height so content is never clipped.
 * Oversized single blocks are force-placed on their own page.
 */
export async function paginateByHeight(
  blocks: string[],
  opts?: { extraCSS?: string; maxContentHeight?: number }
): Promise<string[]> {
  const fontCSS = await getFontCSS();
  const maxH = opts?.maxContentHeight ?? CONTENT_HEIGHT_PX;
  const heights = await measureBlocks(blocks, fontCSS, opts?.extraCSS || "");

  const pages: string[] = [];
  let cur = "";
  let used = 0;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const h = heights[i];
    if (!b.trim()) continue;

    if (used > 0 && used + h > maxH) {
      pages.push(cur);
      cur = "";
      used = 0;
    }
    cur += b;
    used += h;
    // If a single block alone exceeds page, still flush it as its own page next iteration boundary
    if (used >= maxH) {
      pages.push(cur);
      cur = "";
      used = 0;
    }
  }
  if (cur.trim()) pages.push(cur);
  return pages.length ? pages : ["<p>&nbsp;</p>"];
}

export interface RenderPDFOptions {
  headerText: string;
  /** html2canvas scale — 2 is sharp for screen/print without huge memory */
  scale?: number;
  /** JPEG quality 0-1; ignored when usePng is true */
  jpegQuality?: number;
  usePng?: boolean;
  onProgress?: (done: number, total: number) => void;
  extraCSS?: string;
}

/**
 * Render each page HTML (content only) into a multi-page A4 PDF.
 * Uses higher canvas scale + quality to reduce blur.
 */
export async function renderPagesToPDF(
  pageContents: string[],
  opts: RenderPDFOptions
): Promise<Blob> {
  const { default: jsPDF } = await import("jspdf");
  const { default: html2canvas } = await import("html2canvas");
  const fontCSS = await getFontCSS();

  const scale = opts.scale ?? 2;
  const usePng = opts.usePng ?? false;
  const jpegQuality = opts.jpegQuality ?? 0.92;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });

  for (let i = 0; i < pageContents.length; i++) {
    if (i > 0) doc.addPage();
    opts.onProgress?.(i + 1, pageContents.length);

    const pageHTML = buildPageHTML(pageContents[i], opts.headerText, i + 1, fontCSS, opts.extraCSS);
    const iframe = document.createElement("iframe");
    iframe.style.cssText = `position:fixed;left:-10000px;top:0;width:${PAGE_WIDTH_PX}px;height:${PAGE_HEIGHT_PX}px;opacity:0;pointer-events:none;border:0;`;
    document.body.appendChild(iframe);

    try {
      const iframeDoc = iframe.contentDocument!;
      iframeDoc.open();
      iframeDoc.write(pageHTML);
      iframeDoc.close();

      await iframe.contentWindow!.document.fonts.ready;
      await new Promise((r) => setTimeout(r, 120));

      const canvas = await html2canvas(iframeDoc.body, {
        scale,
        useCORS: true,
        allowTaint: true,
        logging: false,
        backgroundColor: "#ffffff",
        width: PAGE_WIDTH_PX,
        height: PAGE_HEIGHT_PX,
        windowWidth: PAGE_WIDTH_PX,
        windowHeight: PAGE_HEIGHT_PX,
      });

      // Prefer JPEG at high quality for smaller files; PNG for max sharpness if requested
      if (usePng) {
        doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, 210, 297);
      } else {
        doc.addImage(canvas.toDataURL("image/jpeg", jpegQuality), "JPEG", 0, 0, 210, 297);
      }
    } finally {
      document.body.removeChild(iframe);
    }
  }

  return doc.output("blob");
}
