import { escapeHTML, paginateByHeight, renderPagesToPDF } from "@/lib/docgen/pdf-render";

/** Convert markdown body (no auto TOC) into HTML block list for measurement. */
export function markdownToBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let inCodeBlock = false;
  let codeBuf: string[] = [];
  let paraBuf: string[] = [];

  const flushPara = () => {
    if (!paraBuf.length) return;
    const text = paraBuf.join("").trim();
    paraBuf = [];
    if (!text) return;
    const cleaned = text
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "<strong>$1</strong>")
      .replace(/_{1,2}([^_]+)_{1,2}/g, "<em>$1</em>");
    // lists
    if (/^[-*•]\s+/.test(text) || /^\d+[\.、]\s+/.test(text)) {
      blocks.push(`<p style="text-indent:0;margin-left:1.5em">${cleaned.replace(/^[-*•]\s+/, "• ").replace(/^\d+[\.、]\s+/, (m) => m)}</p>`);
    } else {
      blocks.push(`<p>${cleaned}</p>`);
    }
  };

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (inCodeBlock) {
        blocks.push(`<pre>${escapeHTML(codeBuf.join("\n"))}</pre>`);
        codeBuf = [];
        inCodeBlock = false;
      } else {
        flushPara();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBuf.push(line);
      continue;
    }

    // Skip AI-generated TOC sections — we build TOC ourselves
    if (/^(#+\s*)?(目\s*录|目录|CONTENTS?)\s*$/i.test(trimmed)) {
      flushPara();
      continue;
    }

    if (/^###\s+/.test(trimmed)) {
      flushPara();
      blocks.push(`<h3>${escapeHTML(trimmed.replace(/^###\s+/, ""))}</h3>`);
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      flushPara();
      blocks.push(`<h2>${escapeHTML(trimmed.replace(/^##\s+/, ""))}</h2>`);
      continue;
    }
    if (/^#\s+/.test(trimmed)) {
      flushPara();
      blocks.push(`<h1>${escapeHTML(trimmed.replace(/^#\s+/, ""))}</h1>`);
      continue;
    }
    if (/^\[图[\d\-IVX]+[：:]/.test(trimmed) || /^【图/.test(trimmed)) {
      flushPara();
      blocks.push(`<div class="fig-placeholder">${escapeHTML(trimmed)}</div>`);
      continue;
    }
    if (!trimmed) {
      flushPara();
      continue;
    }
    // accumulate soft-wrapped paragraph lines
    paraBuf.push(trimmed);
    // treat consecutive non-empty as one paragraph if mid-sentence continuation is rare in CN docs —
    // flush each non-empty line as its own paragraph for stable pagination (说明书风格)
    flushPara();
  }
  flushPara();
  if (inCodeBlock && codeBuf.length) {
    blocks.push(`<pre>${escapeHTML(codeBuf.join("\n"))}</pre>`);
  }
  return blocks;
}

/** Extract unique top-level chapter titles for TOC. */
export function extractChapters(markdown: string): string[] {
  const seen = new Set<string>();
  const chapters: string[] = [];
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    // only H1
    if (!/^#\s+/.test(trimmed) || /^##\s+/.test(trimmed)) continue;
    let title = trimmed.replace(/^#\s+/, "").trim();
    // skip TOC heading itself
    if (/^(目\s*录|目录|CONTENTS?)$/i.test(title)) continue;
    // normalize full-width spaces
    title = title.replace(/\s+/g, " ").trim();
    const key = title.replace(/[第章节\s\d一二三四五六七八九十百]+/g, "").toLowerCase() || title;
    // dedupe by normalized key and exact title
    if (seen.has(title) || seen.has(key)) continue;
    seen.add(title);
    seen.add(key);
    chapters.push(title);
  }
  return chapters;
}

/** Remove duplicate consecutive chapters / AI-injected TOC from markdown body. */
export function cleanManualMarkdown(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let skippingToc = false;
  let lastH1 = "";
  const seenH1 = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Drop standalone TOC blocks produced by the model
    if (/^(#+\s*)?(目\s*录|目录|CONTENTS?)\s*$/i.test(trimmed)) {
      skippingToc = true;
      continue;
    }
    if (skippingToc) {
      // end TOC skip when a real chapter heading appears
      if (/^#\s+第?[一二三四五六七八九十\d]+/.test(trimmed) || /^#\s+.+/.test(trimmed)) {
        skippingToc = false;
      } else if (!trimmed) {
        continue;
      } else if (/^#/.test(trimmed)) {
        skippingToc = false;
      } else {
        // toc entry lines
        continue;
      }
    }

    if (/^#\s+/.test(trimmed) && !/^##\s+/.test(trimmed)) {
      const title = trimmed.replace(/^#\s+/, "").trim();
      if (/^(目\s*录|目录)$/i.test(title)) continue;
      if (title === lastH1 || seenH1.has(title)) {
        // skip duplicate chapter heading but keep following new content
        lastH1 = title;
        continue;
      }
      seenH1.add(title);
      lastH1 = title;
    }

    out.push(lines[i]);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Measure the real A4 body-page count using the same layout engine as PDF export. */
export async function countManualBodyPages(markdown: string): Promise<number> {
  const cleaned = cleanManualMarkdown(markdown);
  const blocks = markdownToBlocks(cleaned);
  const pages = await paginateByHeight(blocks);
  return pages.length;
}

/**
 * 一般交存 requires the first 30 and last 30 consecutive pages of the document,
 * or the complete document when it contains fewer than 60 body pages. This is
 * an export selection rule; it must not limit generation of the complete manual.
 */
const MAX_BODY_PAGES = 60;
const FRONT_PAGES = 30;

/** Keep the deposit-relevant front/back pages when the manual runs long. */
function limitBodyPages(bodyPages: string[]): { pages: string[]; trimmed: number } {
  if (bodyPages.length <= MAX_BODY_PAGES) return { pages: bodyPages, trimmed: 0 };
  const backCount = MAX_BODY_PAGES - FRONT_PAGES;
  const front = bodyPages.slice(0, FRONT_PAGES);
  const back = bodyPages.slice(-backCount);
  return { pages: [...front, ...back], trimmed: bodyPages.length - MAX_BODY_PAGES };
}

export async function generateManualPDF(
  softwareName: string,
  version: string,
  _developerName: string,
  markdown: string,
  onProgress?: (msg: string) => void
): Promise<Blob> {
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;
  const cleaned = cleanManualMarkdown(markdown || "");
  const chapters = extractChapters(cleaned);

  const coverHTML = `<div class="cover">
    <h1>${escapeHTML(softwareName)}</h1>
    <div class="subtitle">操作说明书</div>
    <div class="meta">${escapeHTML(version)}</div>
    <div class="meta">${dateStr}</div>
  </div>`;

  // Complete, de-duplicated TOC (page numbers omitted — soft copyright deposit usually doesn't require linked TOC)
  const tocItems = chapters.length
    ? chapters.map((c, idx) => `<p class="toc-item">${idx + 1}. ${escapeHTML(c)}</p>`).join("")
    : `<p class="toc-item">（正文生成后自动提取章节）</p>`;
  const tocHTML = `<div class="toc-title">目  录</div>${tocItems}`;

  onProgress?.("正在解析说明书结构...");
  const bodyBlocks = markdownToBlocks(cleaned);

  onProgress?.("正在按实际高度分页（避免底部裁切）...");
  const allBodyPages = await paginateByHeight(bodyBlocks);
  const { pages: bodyPages, trimmed } = limitBodyPages(allBodyPages);
  if (trimmed > 0) {
    onProgress?.(
      `说明书共 ${allBodyPages.length} 页，按一般交存要求保留前 ${FRONT_PAGES} 页与后 ${MAX_BODY_PAGES - FRONT_PAGES} 页（省略中间 ${trimmed} 页）...`
    );
  }

  const pages: string[] = [coverHTML, tocHTML, ...bodyPages];

  onProgress?.(`正在高清渲染 PDF（共 ${pages.length} 页）...`);
  return renderPagesToPDF(pages, {
    headerText: `${softwareName} ${version}`,
    scale: 2,
    jpegQuality: 0.92,
    onProgress: (done, total) => onProgress?.(`正在渲染 PDF ${done}/${total} 页...`),
  });
}
