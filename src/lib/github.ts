import { stripComments, sanitizeCode } from "@/lib/utils";

export interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  description: string | null;
  language: string | null;
  stargazers_count: number;
  updated_at: string;
  pushed_at: string;
  owner: { login: string };
  html_url: string;
  default_branch: string;
}

export interface GitHubBranch {
  name: string;
}

interface GitHubFile {
  path: string;
  type: string;
  size?: number;
}

interface GitHubTreeResponse {
  tree: GitHubFile[];
  /** GitHub sets this when the recursive listing hit its size limit. */
  truncated?: boolean;
}

interface GitHubContentResponse {
  content: string;
  encoding: string;
}

// Non-core code files — excluded from source code document
const NON_CODE_EXT = new Set([
  ".css", ".scss", ".less", ".sass", ".styl",
  ".json", ".yaml", ".yml", ".toml", ".ini", ".conf", ".cfg",
  ".md", ".txt", ".rst", ".doc",
  ".html", ".htm", ".xml", ".svg",
  ".lock", ".map",
  ".env", ".gitignore", ".gitattributes",
  ".editorconfig", ".prettierrc", ".eslintrc",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp",
  ".mp4", ".mp3", ".avi", ".mov", ".wav",
  ".ttf", ".woff", ".woff2", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".rar", ".7z",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
  ".pyc", ".pyo", ".class", ".o",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".next", "dist", "build", "vendor",
  "__pycache__", ".git", ".github", ".vscode", ".idea",
  "coverage", ".turbo", ".cache", "target", "bin", "obj",
]);

const IGNORED_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "bun.lockb", "Cargo.lock", "poetry.lock",
  ".DS_Store", "Thumbs.db",
  "README.md", "README", "README.txt", "README.rst",
  "LICENSE", "LICENSE.md", "LICENSE.txt", "LICENCE", "LICENCE.md",
  "CHANGELOG.md", "CHANGELOG", "CHANGES.md",
  "CONTRIBUTING.md", "CODE_OF_CONDUCT.md",
  "SECURITY.md", "NOTICE", "NOTICE.md",
  ".gitignore", ".gitattributes", ".editorconfig",
  ".prettierrc", ".prettierrc.json", ".prettierrc.js",
  ".eslintrc", ".eslintrc.json", ".eslintrc.js",
  "tsconfig.json", "jsconfig.json",
  ".env.example", ".env.sample",
  "Makefile.am", "configure.ac",
]);

const IGNORED_PATTERNS = [
  /\.test\.\w+$/, /\.spec\.\w+$/, /\.min\.\w+$/, /\.map$/, /\.d\.ts$/,
];

function shouldIgnore(path: string): boolean {
  const parts = path.split("/");
  const fileName = parts[parts.length - 1];
  for (const dir of parts.slice(0, -1)) {
    if (IGNORED_DIRS.has(dir)) return true;
  }
  if (IGNORED_FILES.has(fileName)) return true;
  const ext = "." + fileName.split(".").pop()?.toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  for (const p of IGNORED_PATTERNS) {
    if (p.test(fileName)) return true;
  }
  return false;
}

function getExt(path: string): string {
  const fileName = path.split("/").pop() || "";
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

export async function fetchUserRepos(token: string): Promise<GitHubRepo[]> {
  const res = await fetch(
    "https://api.github.com/user/repos?per_page=100&sort=updated",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("获取仓库列表失败，请检查 Token");
  return res.json();
}

export async function fetchRepoBranches(token: string, owner: string, repo: string): Promise<GitHubBranch[]> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/branches?per_page=100`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("获取仓库分支列表失败");
  return res.json();
}

/** Single-repo metadata — used to backfill the description for older projects. */
export async function fetchRepo(token: string, owner: string, repo: string): Promise<GitHubRepo> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("获取仓库信息失败");
  return res.json();
}

/**
 * Tree listing plus GitHub's `truncated` flag.
 *
 * The recursive trees API caps its response; past that limit GitHub silently
 * returns a partial list. Anything counting 源程序量 has to know, otherwise a huge
 * repo reports a confidently wrong number.
 */
async function fetchTreeWithFlags(
  token: string, owner: string, repo: string, branch: string
): Promise<{ files: GitHubFile[]; truncated: boolean; rawCount: number }> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("获取仓库文件树失败");
  const data: GitHubTreeResponse = await res.json();
  const blobs = data.tree.filter((f) => f.type === "blob");
  return {
    files: blobs.filter((f) => !shouldIgnore(f.path)),
    truncated: !!data.truncated,
    rawCount: blobs.length,
  };
}

async function fetchContent(
  token: string, owner: string, repo: string, path: string
): Promise<{ content: string; ok: boolean }> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  // Returning "" silently on failure made a repo-wide fetch failure look like a
  // set of empty files, which then counted as 1 line each. Report the outcome so
  // callers can tell "empty file" from "could not read".
  if (!res.ok) return { content: "", ok: false };
  const data: GitHubContentResponse = await res.json();
  if (data.encoding === "base64") {
    try {
      return { content: atob(data.content.replace(/\n/g, "")), ok: true };
    } catch {
      return { content: "", ok: false };
    }
  }
  return { content: typeof data.content === "string" ? data.content : "", ok: true };
}

/**
 * Files that count toward 源程序量.
 *
 * Deliberately different from `filterByLanguageRatio`: that one narrows to the
 * top few extensions because the code appendix should read as one coherent
 * program, but line COUNTING must cover every source file in the repo. Using the
 * narrow filter for counting under-reported polyglot repos badly — a project with
 * Vue + TS + JS dominant would silently drop its Kotlin, Java and Python files.
 */
function selectCountableCodeFiles(tree: GitHubFile[]): GitHubFile[] {
  return tree.filter((f) => !NON_CODE_EXT.has(getExt(f.path)) && (f.size || 0) > 0);
}

/** Count source lines, treating an empty file as 0 rather than 1. */
function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split("\n").length;
  // Trailing newline shouldn't add a phantom line.
  return text.endsWith("\n") ? n - 1 : n;
}

// ── Smart filtering: prioritize by language ratio ──

function filterByLanguageRatio(tree: GitHubFile[]): GitHubFile[] {
  // Count files by extension
  const extCounts: Record<string, number> = {};
  for (const f of tree) {
    const ext = getExt(f.path);
    if (!NON_CODE_EXT.has(ext)) {
      extCounts[ext] = (extCounts[ext] || 0) + 1;
    }
  }

  // Find dominant extensions (top 3 by count, must be > 5% of total)
  const total = Object.values(extCounts).reduce((a, b) => a + b, 0);
  if (total === 0) return tree;

  const dominantExts = new Set(
    Object.entries(extCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .filter(([, count]) => count / total > 0.05)
      .map(([ext]) => ext)
  );

  // If no dominant extensions found, keep all non-NON_CODE files
  if (dominantExts.size === 0) return tree.filter((f) => !NON_CODE_EXT.has(getExt(f.path)));

  // Keep files with dominant extensions + any non-NON_CODE file if it's in top 3 langs
  return tree.filter((f) => {
    const ext = getExt(f.path);
    if (NON_CODE_EXT.has(ext)) return false;
    if (dominantExts.has(ext)) return true;
    return false;
  });
}

const MAX_FILES = 200;
const MAX_TOTAL_CHARS = 500_000;

export async function fetchRepoFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  onProgress?: (msg: string, percent: number) => void
): Promise<{
  files: { path: string; content: string }[];
  allFilePaths: string[];
  languages: string[];
  extRatios: { ext: string; count: number; ratio: number }[];
  totalTreeSize: number;
  /**
   * Source lines across the whole repo's code files: real counts for the files we
   * downloaded, blob-size estimates (calibrated against those reads) for the rest.
   * `files` is capped by MAX_FILES / MAX_TOTAL_CHARS for the code appendix, so
   * counting only those under-reports 源程序量 badly on any repo past the cap.
   */
  totalSourceLines: number;
  /** How many files were actually read (vs. estimated). */
  readFileCount: number;
  /** Code files in the repo that count toward 源程序量. */
  codeFileCount: number;
  /** Countable files whose lines were estimated rather than read. */
  estimatedFileCount: number;
  /** Per-extension breakdown of the total, so the figure can be sanity-checked. */
  linesByExtension: { ext: string; files: number; lines: number }[];
  /** GitHub truncated the tree listing — the total is a floor, not the real size. */
  treeTruncated: boolean;
  /** Bytes-per-line ratio used for the estimated files. */
  bytesPerLine: number;
}> {
  onProgress?.("正在读取仓库文件列表...", 5);
  const { files: fullTree, truncated } = await fetchTreeWithFlags(token, owner, repo, branch);
  if (truncated) {
    onProgress?.("注意：仓库文件过多，GitHub 只返回了部分文件树，源程序量会偏小", 5);
  }

  // Compute extension ratios from full tree (for AI and UI)
  const extCounts: Record<string, number> = {};
  for (const f of fullTree) {
    const ext = getExt(f.path);
    if (ext) extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const totalFiles = fullTree.length;
  const extRatios = Object.entries(extCounts)
    .map(([ext, count]) => ({ ext, count, ratio: count / totalFiles }))
    .sort((a, b) => b.count - a.count);

  // Collect all file paths (for dev tools detection)
  const allFilePaths = fullTree.map((f) => f.path);

  // Collect languages from dominant code extensions
  const languages = extRatios
    .filter((r) => !NON_CODE_EXT.has(r.ext) && r.ratio > 0.03)
    .slice(0, 10)
    .map((r) => r.ext.replace(".", "").toUpperCase());

  // Filter to substantive code files
  const filteredTree = filterByLanguageRatio(fullTree);
  const filesToRead = filteredTree.slice(0, MAX_FILES);
  const total = filesToRead.length;
  /** Raw line counts for files we read, so counting never re-derives them. */
  const rawLinesByPath = new Map<string, number>();

  const files: { path: string; content: string }[] = [];
  const readPaths = new Set<string>();
  let totalChars = 0;
  /**
   * Lines of the ORIGINAL file, not the comment-stripped copy.
   *
   * 源程序量 means the size of the source code; comment stripping exists only to
   * fit more of the program into the PDF appendix. Counting stripped lines both
   * under-reported the total and skewed the bytes-per-line ratio below (blob sizes
   * are raw bytes, so dividing them by stripped lines inflated bytes/line and
   * therefore shrank every estimate).
   */
  let readRawLines = 0;
  let failedReads = 0;
  let stopped = false;

  const BATCH = 10;
  for (let i = 0; i < total; i += BATCH) {
    if (stopped) break;
    const batch = filesToRead.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (f) => {
        const { content: raw, ok } = await fetchContent(token, owner, repo, f.path);
        // Strip comments and sanitize
        const cleaned = stripComments(sanitizeCode(raw), f.path);
        return { path: f.path, content: cleaned, rawLines: countLines(raw), ok };
      })
    );
    for (const r of results) {
      if (!r.ok) failedReads++;
      files.push({ path: r.path, content: r.content });
      readPaths.add(r.path);
      readRawLines += r.rawLines;
      rawLinesByPath.set(r.path, r.rawLines);
      totalChars += r.content.length;
      if (totalChars >= MAX_TOTAL_CHARS) {
        stopped = true;
        break;
      }
    }
    const read = Math.min(i + BATCH, total);
    const percent = 5 + Math.round((read / total) * 20);
    onProgress?.(`正在读取文件... (${files.length}/${filteredTree.length})${stopped ? " (已足够)" : ""}`, percent);
  }

  // ── 源程序量 ──
  //
  // Counted over EVERY code file in the repo, not just `filteredTree`. The latter
  // narrows to the top few extensions so the code appendix reads coherently; using
  // it for counting dropped whole languages (a Vue/TS repo silently lost its
  // Kotlin, Java and Python files), which is how a ~100k-line repo reported ~8k.
  const countableFiles = selectCountableCodeFiles(fullTree);

  // Calibrate bytes-per-line against the files we actually read, then apply that
  // ratio to everything we didn't. Both sides are raw: blob size ÷ raw line count.
  // The 36 fallback only applies when nothing could be sampled; measured across
  // real sources it ranges ~30 (plain JS/config-heavy) to ~50 (JSX with long
  // class attributes), so a measured ratio always beats it.
  let bytesPerLine = 36;
  const readBytes = filesToRead
    .filter((f) => readPaths.has(f.path))
    .reduce((sum, f) => sum + (f.size || 0), 0);
  if (readRawLines > 0 && readBytes > 0) {
    const observed = readBytes / readRawLines;
    if (observed >= 8 && observed <= 200) bytesPerLine = observed;
  }

  let countedLines = 0;
  let estimatedFileCount = 0;
  // Per-extension breakdown so the reported total is auditable rather than a
  // single opaque number.
  const byExt = new Map<string, { files: number; lines: number }>();
  const bump = (path: string, lines: number) => {
    const ext = getExt(path) || "(无扩展名)";
    const cur = byExt.get(ext) || { files: 0, lines: 0 };
    cur.files++;
    cur.lines += lines;
    byExt.set(ext, cur);
  };
  for (const f of countableFiles) {
    const known = rawLinesByPath.get(f.path);
    if (known != null) {
      countedLines += known;
      bump(f.path, known);
      continue;
    }
    const est = Math.round((f.size || 0) / bytesPerLine);
    countedLines += est;
    estimatedFileCount++;
    bump(f.path, est);
  }

  const linesByExtension = Array.from(byExt.entries())
    .map(([ext, v]) => ({ ext, files: v.files, lines: v.lines }))
    .sort((a, b) => b.lines - a.lines);

  if (failedReads > 0) {
    onProgress?.(`有 ${failedReads} 个文件读取失败，已跳过其内容`, 25);
  }

  return {
    files,
    allFilePaths,
    languages,
    extRatios,
    totalTreeSize: fullTree.length,
    totalSourceLines: countedLines,
    readFileCount: files.length,
    codeFileCount: countableFiles.length,
    estimatedFileCount,
    linesByExtension,
    treeTruncated: truncated,
    bytesPerLine: Math.round(bytesPerLine * 10) / 10,
  };
}

// ── Accurate language detection via GitHub Linguist ──

/**
 * GitHub's own language stats (byte counts per language). Far more accurate than
 * counting file extensions: Linguist ignores vendored/generated files and weighs
 * by actual code volume, so a repo with 200 tiny config files won't drown out the
 * real implementation language.
 */
export async function fetchRepoLanguages(
  token: string,
  owner: string,
  repo: string
): Promise<{ name: string; bytes: number; ratio: number }[]> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/languages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Record<string, number>;
  const total = Object.values(data).reduce((a, b) => a + b, 0);
  if (!total) return [];
  return Object.entries(data)
    .map(([name, bytes]) => ({ name, bytes, ratio: bytes / total }))
    .sort((a, b) => b.bytes - a.bytes);
}

/** Files whose contents best describe what a project actually does. */
const INSIGHT_FILES = [
  "README.md", "README", "README.txt", "README.rst", "readme.md",
  "package.json", "pyproject.toml", "requirements.txt", "Cargo.toml",
  "go.mod", "pom.xml", "build.gradle", "composer.json", "Gemfile",
  "docker-compose.yml", "Dockerfile",
];

/**
 * Read the prose out of a documentation repository.
 *
 * Used for importing 软著 rule collections: those repos are mostly Markdown, and
 * what matters is the text, not the structure. Reads the largest Markdown files
 * (README first) up to a character budget, since a rules repo's substance is
 * usually concentrated in a few long documents.
 */
export async function fetchRepoMarkdown(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  opts?: { maxChars?: number; maxFiles?: number; onProgress?: (msg: string) => void }
): Promise<{ docs: { path: string; content: string }[]; totalChars: number; skipped: number }> {
  const maxChars = opts?.maxChars ?? 120_000;
  const maxFiles = opts?.maxFiles ?? 25;
  opts?.onProgress?.("正在读取仓库文件树...");

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("获取仓库文件树失败，请确认仓库地址和分支");
  const data: GitHubTreeResponse = await res.json();

  const mdFiles = data.tree
    .filter((f) => f.type === "blob" && /\.(md|markdown|txt|rst)$/i.test(f.path))
    .filter((f) => {
      const parts = f.path.split("/");
      return !parts.slice(0, -1).some((d) => IGNORED_DIRS.has(d));
    })
    .sort((a, b) => {
      // README first, then by size — the substance tends to be in long documents.
      const aRoot = /^readme\./i.test(a.path) ? 1 : 0;
      const bRoot = /^readme\./i.test(b.path) ? 1 : 0;
      if (aRoot !== bRoot) return bRoot - aRoot;
      return (b.size || 0) - (a.size || 0);
    });

  if (mdFiles.length === 0) throw new Error("该仓库中没有找到 Markdown/文本文档");

  const docs: { path: string; content: string }[] = [];
  let totalChars = 0;
  let skipped = 0;
  for (const f of mdFiles) {
    if (docs.length >= maxFiles || totalChars >= maxChars) {
      skipped++;
      continue;
    }
    opts?.onProgress?.(`正在读取 ${f.path} (${docs.length + 1}/${Math.min(mdFiles.length, maxFiles)})...`);
    const { content, ok } = await fetchContent(token, owner, repo, f.path);
    if (!ok || !content.trim()) {
      skipped++;
      continue;
    }
    const room = maxChars - totalChars;
    const slice = content.length > room ? content.slice(0, room) : content;
    docs.push({ path: f.path, content: slice });
    totalChars += slice.length;
  }

  if (docs.length === 0) throw new Error("未能读取到任何文档内容");
  return { docs, totalChars, skipped };
}

/** Parse `owner/repo`, a full GitHub URL, or a URL with `/tree/<branch>`. */
export function parseRepoRef(input: string): { owner: string; repo: string; branch?: string } | null {
  const text = input.trim().replace(/\.git$/, "");
  if (!text) return null;

  const urlMatch = /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)(?:\/tree\/([^/\s]+))?/i.exec(text);
  if (urlMatch) {
    return { owner: urlMatch[1], repo: urlMatch[2], branch: urlMatch[3] };
  }
  const shortMatch = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2] };
  return null;
}

export interface RepoInsights {
  /** README text (truncated) — richest source of purpose/features */
  readme: string;
  /** Dependency manifests, keyed by filename */
  manifests: { path: string; content: string }[];
  /** Directory names at depth 1–2, describing module layout */
  moduleDirs: string[];
  /** Representative source file paths */
  sourcePaths: string[];
}

/**
 * Gather the human-meaningful context for metadata generation: README, dependency
 * manifests, and module layout. The previous implementation passed only 50 raw file
 * paths and an empty code summary, which is why 开发目的/主要功能 came out vague.
 */
export async function fetchRepoInsights(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  allFilePaths: string[]
): Promise<RepoInsights> {
  const pathSet = new Map(allFilePaths.map((p) => [p.toLowerCase(), p]));

  // README lives at repo root; try the common spellings.
  let readme = "";
  for (const cand of ["readme.md", "readme", "readme.txt", "readme.rst"]) {
    const actual = pathSet.get(cand);
    if (actual) {
      readme = (await fetchContent(token, owner, repo, actual)).content;
      if (readme) break;
    }
  }
  // README.md is in IGNORED_FILES so it may be absent from allFilePaths — fetch directly.
  if (!readme) {
    readme = (await fetchContent(token, owner, repo, "README.md")).content;
  }

  const manifests: { path: string; content: string }[] = [];
  for (const name of INSIGHT_FILES) {
    if (/^readme/i.test(name)) continue;
    const actual = pathSet.get(name.toLowerCase()) || (name === "package.json" ? name : null);
    if (!actual) continue;
    const { content } = await fetchContent(token, owner, repo, actual);
    if (content) manifests.push({ path: actual, content: content.slice(0, 3000) });
    if (manifests.length >= 4) break;
  }

  // Module layout: directory names at depth 1 and 2 hint at feature boundaries.
  const dirs = new Set<string>();
  for (const p of allFilePaths) {
    const parts = p.split("/");
    if (parts.length > 1) dirs.add(parts.slice(0, 1).join("/"));
    if (parts.length > 2) dirs.add(parts.slice(0, 2).join("/"));
  }
  const moduleDirs = Array.from(dirs).sort().slice(0, 60);

  // Prefer files that look like entry points / feature modules over deep utilities.
  const sourcePaths = allFilePaths
    .filter((p) => !NON_CODE_EXT.has(getExt(p)))
    .sort((a, b) => a.split("/").length - b.split("/").length)
    .slice(0, 80);

  return { readme: readme.slice(0, 6000), manifests, moduleDirs, sourcePaths };
}

// ── Lightweight stats: fetch tree only, no content ──

export async function fetchRepoStats(
  token: string,
  owner: string,
  repo: string,
  branch: string
): Promise<{
  allFilePaths: string[];
  languages: string[];
  estimatedLines: number;
  totalTreeSize: number;
}> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error("获取仓库文件树失败");
  const data: GitHubTreeResponse = await res.json();
  const tree = data.tree.filter((f) => f.type === "blob" && !shouldIgnore(f.path));

  const allFilePaths = tree.map((f) => f.path);

  // Extension ratios
  const extCounts: Record<string, number> = {};
  for (const f of tree) {
    const ext = getExt(f.path);
    if (ext) extCounts[ext] = (extCounts[ext] || 0) + 1;
  }
  const totalFiles = tree.length;
  const extRatios = Object.entries(extCounts)
    .map(([ext, count]) => ({ ext, count, ratio: count / totalFiles }))
    .sort((a, b) => b.count - a.count);

  const languages = extRatios
    .filter((r) => !NON_CODE_EXT.has(r.ext) && r.ratio > 0.03)
    .slice(0, 10)
    .map((r) => r.ext.replace(".", "").toUpperCase());

  // Estimate lines from code files only — counting every blob (JSON fixtures,
  // lock files, SVGs) inflates 源程序量. Same file selection as the full run so
  // the pre-generation figure and the final registered figure don't disagree.
  // 36 bytes/line is a rough average for raw source; the full run and the
  // 「重新估算」 button both replace it with a per-extension measured ratio.
  const codeBytes = selectCountableCodeFiles(tree).reduce((sum, f) => sum + (f.size || 0), 0);
  const estimatedLines = Math.round(codeBytes / 36);

  return { allFilePaths, languages, estimatedLines, totalTreeSize: tree.length };
}

/**
 * Re-estimate 源程序量 without doing a full generation run.
 *
 * Samples real files spread across the repo, measures this project's own
 * bytes-per-line, and applies that ratio to every code file. Sampling keeps it to
 * ~40 content requests instead of hundreds. Lines are counted on the ORIGINAL
 * file: 源程序量 is the size of the source, and blob sizes on the other side of
 * the ratio are raw bytes, so stripping comments on one side only would skew it.
 */
export async function estimateRepoSourceLines(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  onProgress?: (msg: string) => void
): Promise<{
  sourceLines: number;
  codeFileCount: number;
  sampledFileCount: number;
  bytesPerLine: number;
  /** Per-extension breakdown, largest first. */
  linesByExtension: { ext: string; files: number; lines: number }[];
  /** GitHub truncated the tree listing — the figure is a floor. */
  treeTruncated: boolean;
}> {
  onProgress?.("正在读取仓库文件树...");
  const { files: fullTree, truncated } = await fetchTreeWithFlags(token, owner, repo, branch);
  const codeFiles = selectCountableCodeFiles(fullTree);
  if (codeFiles.length === 0) {
    return {
      sourceLines: 0, codeFileCount: 0, sampledFileCount: 0, bytesPerLine: 36,
      linesByExtension: [], treeTruncated: truncated,
    };
  }

  // Sample per extension rather than across the flat list: one global ratio
  // applied to a polyglot repo is wrong for every language but the average, and
  // extensions differ a lot (a .java line is far longer than a .py line).
  const byExt = new Map<string, GitHubFile[]>();
  for (const f of codeFiles) {
    const ext = getExt(f.path) || "(无扩展名)";
    const list = byExt.get(ext);
    if (list) list.push(f);
    else byExt.set(ext, [f]);
  }

  const PER_EXT_SAMPLE = 5;
  const MAX_SAMPLE = 40;
  const sample: GitHubFile[] = [];
  // Bigger extension groups first, so the request budget goes where it matters.
  const extsBySize = Array.from(byExt.entries()).sort(
    (a, b) =>
      b[1].reduce((s, f) => s + (f.size || 0), 0) - a[1].reduce((s, f) => s + (f.size || 0), 0)
  );
  for (const [, list] of extsBySize) {
    if (sample.length >= MAX_SAMPLE) break;
    const step = Math.max(1, Math.floor(list.length / PER_EXT_SAMPLE));
    let taken = 0;
    for (let i = 0; i < list.length && taken < PER_EXT_SAMPLE && sample.length < MAX_SAMPLE; i += step) {
      sample.push(list[i]);
      taken++;
    }
  }

  onProgress?.(`正在抽样 ${sample.length} 个文件以校准行数...`);
  const perExt = new Map<string, { bytes: number; lines: number; ok: number }>();
  let sampledOk = 0;
  const BATCH = 10;
  for (let i = 0; i < sample.length; i += BATCH) {
    const batch = sample.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (f) => {
        const { content, ok } = await fetchContent(token, owner, repo, f.path);
        return {
          ext: getExt(f.path) || "(无扩展名)",
          size: f.size || 0,
          lines: countLines(content),
          ok,
        };
      })
    );
    for (const r of results) {
      if (!r.ok || r.lines === 0) continue;
      sampledOk++;
      const cur = perExt.get(r.ext) || { bytes: 0, lines: 0, ok: 0 };
      cur.bytes += r.size;
      cur.lines += r.lines;
      cur.ok++;
      perExt.set(r.ext, cur);
    }
  }

  // Global fallback ratio for extensions we couldn't sample.
  const allBytes = Array.from(perExt.values()).reduce((s, v) => s + v.bytes, 0);
  const allLines = Array.from(perExt.values()).reduce((s, v) => s + v.lines, 0);
  let globalRatio = 36;
  if (allLines > 0 && allBytes > 0) {
    const observed = allBytes / allLines;
    if (observed >= 8 && observed <= 200) globalRatio = observed;
  }

  let sourceLines = 0;
  const linesByExtension: { ext: string; files: number; lines: number }[] = [];
  for (const [ext, list] of byExt.entries()) {
    const s = perExt.get(ext);
    let ratio = globalRatio;
    if (s && s.lines > 0 && s.bytes > 0) {
      const observed = s.bytes / s.lines;
      if (observed >= 8 && observed <= 200) ratio = observed;
    }
    const bytes = list.reduce((sum, f) => sum + (f.size || 0), 0);
    const lines = Math.round(bytes / ratio);
    sourceLines += lines;
    linesByExtension.push({ ext, files: list.length, lines });
  }
  linesByExtension.sort((a, b) => b.lines - a.lines);

  return {
    sourceLines,
    codeFileCount: codeFiles.length,
    sampledFileCount: sampledOk,
    bytesPerLine: Math.round(globalRatio * 10) / 10,
    linesByExtension,
    treeTruncated: truncated,
  };
}
