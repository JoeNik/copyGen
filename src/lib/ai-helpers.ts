import { getAIBaseUrl, getAIModel, getActiveProvider, type AIProtocol } from "@/lib/storage";

interface ProviderConfig {
  protocol: AIProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
}

async function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch("/__ai_proxy__", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetUrl: url, method: init.method || "POST", headers: init.headers, body: init.body }),
  });
}

/** Build OpenAI-compatible chat completions URL from a flexible base. */
function openaiChatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  if (b.endsWith("/chat/completions")) return b;
  // Already versioned path, e.g. https://open.bigmodel.cn/api/paas/v4
  if (/\/v\d+$/i.test(b)) return `${b}/chat/completions`;
  // Base already ends with /v1
  if (/\/v1$/i.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

function claudeMessagesUrl(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  if (b.endsWith("/messages")) return b;
  if (/\/v1$/i.test(b)) return `${b}/messages`;
  return `${b}/v1/messages`;
}

/** Extract text + finish reason from a single OpenAI/Claude/Gemini JSON payload. */
function extractFromPayload(
  data: Record<string, unknown>,
  protocol: AIProtocol
): { text: string; finishReason: string } {
  if (protocol === "openai") {
    const choices = data?.choices as Array<{
      message?: { content?: string };
      delta?: { content?: string };
      text?: string;
      finish_reason?: string | null;
    }> | undefined;
    const choice = choices?.[0];
    const text =
      choice?.message?.content ||
      choice?.delta?.content ||
      choice?.text ||
      "";
    // Stream chunks often have finish_reason: null — treat as continue so a later
    // real reason (stop/length) can overwrite it in the aggregator.
    const fr = choice?.finish_reason;
    const finishReason = fr ? fr : choice?.delta ? "continue" : "stop";
    return { text, finishReason };
  }

  if (protocol === "claude") {
    // Non-stream: content[0].text
    // Stream message_delta: delta.stop_reason
    // Stream content_block_delta: delta.text
    const content = data?.content as Array<{ type?: string; text?: string }> | undefined;
    if (Array.isArray(content) && content.length > 0) {
      const text = content
        .filter((c) => c.type === "text" || typeof c.text === "string")
        .map((c) => c.text || "")
        .join("");
      return {
        text,
        finishReason: (data?.stop_reason as string) || "end_turn",
      };
    }

    const type = data?.type as string | undefined;
    if (type === "content_block_delta") {
      const delta = data?.delta as { type?: string; text?: string } | undefined;
      return { text: delta?.text || "", finishReason: "continue" };
    }
    if (type === "message_delta") {
      const delta = data?.delta as { stop_reason?: string } | undefined;
      return { text: "", finishReason: delta?.stop_reason || "end_turn" };
    }
    if (type === "message_stop") {
      return { text: "", finishReason: "end_turn" };
    }
    // message_start / content_block_start / ping — ignore
    return { text: "", finishReason: "continue" };
  }

  // Gemini
  const candidates = data?.candidates as Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }> | undefined;
  const cand = candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || "").join("") || "";
  return { text, finishReason: cand?.finishReason || "STOP" };
}

/**
 * Parse an AI API response that may be:
 * - plain JSON object
 * - SSE stream (`data: {...}` lines, with optional `: heartbeat` comments)
 * - NDJSON (one JSON object per line)
 *
 * Chinese reverse proxies often inject SSE heartbeats even for non-stream
 * requests, which makes `res.json()` throw:
 *   Unexpected token ':', ": heartbea"... is not valid JSON
 */
async function parseAIResponse(
  res: Response,
  protocol: AIProtocol
): Promise<{ text: string; finishReason: string }> {
  const raw = await res.text();
  const trimmed = raw.trim();

  if (!trimmed) {
    return { text: "", finishReason: "stop" };
  }

  // Fast path: pure JSON object/array
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      // OpenAI error body
      if (data.error && typeof data.error === "object") {
        const err = data.error as { message?: string };
        throw new Error(err.message || "AI API 返回错误");
      }
      return extractFromPayload(data, protocol);
    } catch (e) {
      // Fall through to line-based parsing if it wasn't pure JSON
      // (e.g. JSON followed by more data, or partial)
      if (e instanceof Error && e.message.includes("AI API")) throw e;
    }
  }

  // SSE / NDJSON / heartbeat-polluted body
  let text = "";
  let finishReason = "stop";
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;

    // SSE comment / heartbeat — e.g. ": heartbeat", ": keep-alive"
    if (s.startsWith(":")) continue;

    // SSE event name — ignore
    if (s.startsWith("event:")) continue;
    if (s.startsWith("id:")) continue;
    if (s.startsWith("retry:")) continue;

    let payload = s;
    if (s.startsWith("data:")) {
      payload = s.slice(5).trim();
    }

    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") finishReason = finishReason === "continue" ? "stop" : finishReason;
      continue;
    }

    // Some proxies wrap as data: data: {...}
    if (payload.startsWith("data:")) {
      payload = payload.slice(5).trim();
    }

    if (!(payload.startsWith("{") || payload.startsWith("["))) continue;

    try {
      const data = JSON.parse(payload) as Record<string, unknown>;
      if (data.error && typeof data.error === "object") {
        const err = data.error as { message?: string };
        throw new Error(err.message || "AI API 返回错误");
      }
      const part = extractFromPayload(data, protocol);
      if (part.text) text += part.text;
      if (part.finishReason && part.finishReason !== "continue") {
        finishReason = part.finishReason;
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("AI API")) throw e;
      // skip malformed chunk
    }
  }

  // Last resort: try to find a JSON object embedded in the text
  if (!text) {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const data = JSON.parse(match[0]) as Record<string, unknown>;
        return extractFromPayload(data, protocol);
      } catch {
        /* ignore */
      }
    }
  }

  return { text, finishReason };
}

function splitSystemMessages(messages: { role: string; content: string }[]) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  return { system, rest };
}

async function callAI(messages: { role: string; content: string }[], config: ProviderConfig): Promise<string> {
  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (config.protocol === "openai") {
    url = openaiChatCompletionsUrl(config.baseUrl);
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    body = JSON.stringify({ model: config.model, max_tokens: 200, messages });
  } else if (config.protocol === "claude") {
    const { system, rest } = splitSystemMessages(messages);
    url = claudeMessagesUrl(config.baseUrl);
    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    body = JSON.stringify({
      model: config.model,
      max_tokens: 200,
      ...(system ? { system } : {}),
      messages: rest,
    });
  } else {
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const b = config.baseUrl.replace(/\/+$/, "");
    url = `${b}/v1beta/models/${config.model}:generateContent?key=${config.apiKey}`;
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify({ contents, generationConfig: { maxOutputTokens: 200 } });
  }

  const res = await proxyFetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API 错误 (${res.status}): ${err.slice(0, 200)}`);
  }
  const { text } = await parseAIResponse(res, config.protocol);
  return text.trim();
}

export async function callAIForText(prompt: string): Promise<string> {
  const active = getActiveProvider();
  if (!active) throw new Error("请先在设置中配置并启用一个 AI 提供商");
  const config: ProviderConfig = {
    protocol: active.protocol,
    apiKey: active.apiKey,
    baseUrl: active.baseUrl || getAIBaseUrl(),
    model: active.model || getAIModel(),
  };
  return callAI([{ role: "user", content: prompt }], config);
}

export function buildAutoNamePrompt(repoName: string, description: string, language: string): string {
  return `根据以下 GitHub 仓库信息，生成一个适合中国软件著作权登记的软件全称。
格式必须为"XXX软件"，以"软件"二字结尾，不要包含版本号。
只返回软件全称本身，不要返回其他内容。

仓库名称：${repoName}
仓库描述：${description || "无"}
主要语言：${language || "未知"}`;
}

export function buildCategoryPrompt(repoName: string, description: string, language: string): string {
  return `根据以下 GitHub 仓库信息，判断该软件属于哪个分类。
只返回以下选项之一，不要返回其他内容：
- 应用软件
- 嵌入式软件
- 中间件
- 操作系统

仓库名称：${repoName}
仓库描述：${description || "无"}
主要语言：${language || "未知"}`;
}

export function buildLanguagesPrompt(repoName: string, description: string, language: string): string {
  return `根据以下 GitHub 仓库信息，判断该软件使用了哪些编程语言。
从以下选项中选择所有适用的（逗号分隔返回），不要返回选项之外的内容：

Assembly, C, C#, C++, Delphi/Object Pascal, Go, HTML, Java, JavaScript, MATLAB, Objective-C, PHP, PL/SQL, Perl, Python, R, Ruby, SQL, Swift, Visual Basic, Visual Basic .Net

仓库名称：${repoName}
仓库描述：${description || "无"}
主要语言：${language || "未知"}

只返回选中的语言名称，逗号分隔，不要返回其他内容。`;
}

export function buildTechCategoriesPrompt(repoName: string, description: string, language: string): string {
  return `根据以下 GitHub 仓库信息，判断该软件属于哪些技术特点分类。
从以下选项中选择所有适用的（逗号分隔返回），不要返回选项之外的内容：

APP, 游戏软件, 教育软件, 金融软件, 医疗软件, 地理信息软件, 云计算软件, 信息安全软件, 大数据软件, 人工智能软件, VR软件, 5G软件, 小程序, 物联网软件, 智慧城市软件

仓库名称：${repoName}
仓库描述：${description || "无"}
主要语言：${language || "未知"}

只返回选中的分类名称，逗号分隔，不要返回其他内容。如果没有匹配的，返回"应用软件"。`;
}

export function buildMetadataPrompt(
  repoName: string,
  description: string,
  languages: string,
  fileTree: string,
  codeSummary: string
): string {
  return `根据以下 GitHub 仓库信息，返回 JSON 格式的软件元数据。只返回 JSON，不要其他内容。

仓库名称：${repoName}
仓库描述：${description || "无"}
编程语言：${languages}
目录结构：
${fileTree}

代码摘要：
${codeSummary}

返回以下 JSON（每个字段用简洁的中文填写）：
{
  "runPlatform": "该软件的运行平台/操作系统",
  "runSupport": "软件运行支撑环境/支持软件（如 Node.js 18+, Python 3.10+ 等）",
  "purpose": "开发目的（1-2句话）",
  "domain": "面向领域/行业",
  "mainFeatures": "软件的主要功能（3-5个要点，用分号分隔）",
  "technicalFeatures": "软件的技术特点（2-3句话）"
}`;
}

// ── Long-form AI for manual generation ──

// Keep within common provider limits; continuation loop handles long manuals.
const MAX_TOKENS = 8192;

export async function callAILong(messages: { role: string; content: string }[]): Promise<{ text: string; finishReason: string }> {
  const active = getActiveProvider();
  if (!active) throw new Error("请先在设置中配置并启用一个 AI 提供商");
  const config: ProviderConfig = {
    protocol: active.protocol,
    apiKey: active.apiKey,
    baseUrl: active.baseUrl || getAIBaseUrl(),
    model: active.model || getAIModel(),
  };

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (config.protocol === "openai") {
    url = openaiChatCompletionsUrl(config.baseUrl);
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    // stream:true is more reliable through reverse proxies that inject heartbeats
    body = JSON.stringify({ model: config.model, max_tokens: MAX_TOKENS, stream: true, messages });
  } else if (config.protocol === "claude") {
    const { system, rest } = splitSystemMessages(messages);
    url = claudeMessagesUrl(config.baseUrl);
    headers = {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    body = JSON.stringify({
      model: config.model,
      max_tokens: MAX_TOKENS,
      stream: true,
      ...(system ? { system } : {}),
      messages: rest,
    });
  } else {
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const systemInstruction = messages.find((m) => m.role === "system")?.content;
    const b = config.baseUrl.replace(/\/+$/, "");
    url = `${b}/v1beta/models/${config.model}:streamGenerateContent?alt=sse&key=${config.apiKey}`;
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify({
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    });
  }

  const res = await proxyFetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API 错误 (${res.status}): ${err.slice(0, 200)}`);
  }
  return parseAIResponse(res, config.protocol);
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((l) => l.trim()).length;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call long-form AI with automatic retries. Does not discard previously
 * accumulated manual text — callers keep that outside this function.
 */
async function callAILongWithRetry(
  messages: { role: string; content: string }[],
  onProgress?: (msg: string) => void,
  label = "生成"
): Promise<{ text: string; finishReason: string }> {
  const MAX_RETRIES = 5;
  let lastError: unknown;

  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    try {
      if (retry > 0) {
        const waitSec = Math.min(30, 2 ** retry);
        onProgress?.(`${label}失败，${waitSec}s 后自动重试 (${retry}/${MAX_RETRIES})...`);
        await sleep(waitSec * 1000);
        onProgress?.(`正在重试${label}... (${retry}/${MAX_RETRIES})`);
      }
      const result = await callAILong(messages);
      // Empty body on success is also worth a retry once or twice
      if (!result.text.trim() && retry < MAX_RETRIES) {
        lastError = new Error("AI 返回空内容");
        continue;
      }
      return result;
    } catch (e) {
      lastError = e;
      // 401/403: fail fast
      if (/AI API 错误 \((401|403)\)/i.test(e instanceof Error ? e.message : String(e))) break;
      if (retry >= MAX_RETRIES) break;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface GenerateManualOptions {
  /** Persist/resume draft by project id */
  projectId?: string;
  /** Existing draft markdown to continue from */
  resumeMarkdown?: string;
  /** Starting attempt counter when resuming */
  resumeAttempt?: number;
  onProgress?: (msg: string) => void;
  /**
   * Target non-empty Markdown lines for 文档鉴别材料.
   * This is NOT source-code line count (源程序约 3000–6000 行是另一回事).
   * Soft copyright manuals are usually deposited as ~60 pages; ~1500–2000
   * non-empty doc lines is enough to paginate into that range.
   */
  minLines?: number;
}

export async function generateManualMarkdown(
  softwareName: string,
  version: string,
  meta: { purpose: string; domain: string; mainFeatures: string; technicalFeatures: string; runPlatform: string; runSupport: string },
  repoDescription: string,
  languages: string,
  fileTree: string,
  codeSummary: string,
  onProgressOrOpts?: ((msg: string) => void) | GenerateManualOptions
): Promise<string> {
  const opts: GenerateManualOptions =
    typeof onProgressOrOpts === "function"
      ? { onProgress: onProgressOrOpts }
      : onProgressOrOpts || {};

  const onProgress = opts.onProgress;
  // 文档鉴别材料目标行数（说明书 Markdown），与源程序 6000 行无关
  const MIN_LINES = opts.minLines ?? 2000;
  const MAX_ROUNDS = 20;
  const PERSIST_EVERY = true;

  const { saveManualDraft, clearManualDraft, getManualDraft } = await import("@/lib/storage");

  const systemPrompt =
    "你是一名专业的软件著作权申报文档撰写专家。请直接输出完整的 Markdown 文档，不要输出 JSON。每章内容要极其详实，每个功能点都要展开详细的步骤说明，每段至少5句话。";

  const userPrompt = `请生成《${softwareName}》的完整操作说明书（Markdown 格式）。
说明：这里的“行数”指说明书文档行数，用于排版成文档鉴别材料 PDF（一般交存前后各约 30 页），不是源程序代码行数。

软件信息：
- 名称：${softwareName} ${version}
- 用途：${meta.purpose}
- 领域：${meta.domain}
- 主要功能：${meta.mainFeatures}
- 技术特点：${meta.technicalFeatures}
- 运行平台：${meta.runPlatform}
- 运行环境：${meta.runSupport}
- 编程语言：${languages}
- 仓库描述：${repoDescription}

代码结构（前50个文件）：
${fileTree}

代码摘要：
${codeSummary}

章节要求（每章必须内容充实，不少于 150 行）：
# 第一章 软件概述（背景、目标用户分析、核心功能列表、技术架构概述、版本历史）
# 第二章 运行环境（硬件要求详细说明、软件依赖列表、网络要求、安全要求）
# 第三章 软件安装与卸载（Windows安装、Linux安装、macOS安装、Docker部署、卸载步骤）
# 第四章 快速入门（注册登录、主界面说明、各区域功能、快捷操作）
# 第五章 功能模块详细说明（每个功能点都要有详细的步骤1、步骤2...格式，至少覆盖8个功能模块，每个模块不少于30行）
# 第六章 常见问题与解答（至少20条 Q&A，涵盖安装、使用、配置、故障排除等方面）
# 第七章 错误代码与处理方法（列出常见错误码、原因、解决方案）
# 第八章 版本更新说明（版本历史、更新内容、升级指南）

要求：
- 使用正式的中文公文写作风格
- 每段落不少于5句话，内容要详实具体
- 图片位置用 [图X-X：描述] 占位符标注
- 目标总行数 ${MIN_LINES} 行以上（说明书文档行，非代码行）
- 只输出 Markdown，不要输出其他说明`;

  // Resume from explicit arg or saved draft
  let allText = opts.resumeMarkdown || "";
  let attempt = opts.resumeAttempt || 0;
  let emptyStreak = 0;
  let lastTruncated = false;

  if (!allText && opts.projectId) {
    const draft = getManualDraft(opts.projectId);
    if (draft?.markdown && !draft.complete) {
      allText = draft.markdown;
      attempt = draft.attempt || 0;
      onProgress?.(
        `发现未完成的说明书草稿（${draft.lines || countNonEmptyLines(allText)} 行），从断点继续...`
      );
    }
  }

  const persist = (complete = false) => {
    if (!opts.projectId || !PERSIST_EVERY) return;
    const lines = countNonEmptyLines(allText);
    if (!allText.trim()) return;
    saveManualDraft({
      projectId: opts.projectId,
      softwareName,
      version,
      markdown: allText,
      lines,
      attempt,
      updatedAt: new Date().toISOString(),
      complete,
    });
  };

  const buildContinueMessages = (totalLines: number, truncated: boolean) => {
    const tail = allText.slice(-8000);
    if (truncated) {
      return [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        { role: "assistant", content: tail },
        {
          role: "user",
          content: `内容被截断了（当前说明书 ${totalLines} 行，目标 ${MIN_LINES} 行文档行）。请紧接着上文末尾继续写，不要重复已有章节标题和段落。尽量一次输出 400 行以上新内容。`,
        },
      ];
    }
    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
      { role: "assistant", content: tail },
      {
        role: "user",
        content: `当前说明书只有 ${totalLines} 行（文档行，非代码行），目标 ${MIN_LINES} 行。请从文末继续大幅扩充，不要重复已有内容：\n- 补全尚未写完的章节\n- 第五章每个功能模块写清操作步骤\n- 第六章扩到 20 条以上 Q&A\n- 第七章至少 10 个错误码\n一次至少输出 400 行新内容。`,
      },
    ];
  };

  while (attempt < MAX_ROUNDS) {
    attempt++;
    const currentLines = countNonEmptyLines(allText);
    const isContinue = currentLines > 0;
    onProgress?.(
      `正在${isContinue ? "接续" : ""}生成说明书... (第 ${attempt} 轮, 已 ${currentLines} 行文档 / 目标 ${MIN_LINES} 行)`
    );

    const messages =
      currentLines === 0
        ? [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ]
        : buildContinueMessages(currentLines, lastTruncated);

    let text = "";
    let finishReason = "stop";
    try {
      const result = await callAILongWithRetry(
        messages,
        onProgress,
        isContinue ? "接续生成" : "生成说明书"
      );
      text = result.text;
      finishReason = result.finishReason;
    } catch (e) {
      // Keep draft so user can resume; rethrow with context
      persist(false);
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `说明书生成中断（已保存草稿 ${countNonEmptyLines(allText)} 行文档，可从断点继续）：${msg}`
      );
    }

    if (text.trim()) {
      // Avoid duplicating if model repeats the tail
      const tail = allText.slice(-200);
      if (tail && text.startsWith(tail)) {
        allText += text.slice(tail.length);
      } else {
        allText += (allText && !allText.endsWith("\n") && !text.startsWith("\n") ? "\n" : "") + text;
      }
      emptyStreak = 0;
      persist(false);
    } else {
      emptyStreak++;
      onProgress?.(`本轮未返回有效内容 (${emptyStreak}/3)，将重试接续...`);
      if (emptyStreak >= 3) {
        persist(false);
        throw new Error(
          `连续多轮未获得有效内容（已保存草稿 ${countNonEmptyLines(allText)} 行文档，可从断点继续）`
        );
      }
      // retry same round budget with a stronger continue prompt next loop
      continue;
    }

    const totalLines = countNonEmptyLines(allText);
    const fr = finishReason.toLowerCase();
    lastTruncated = fr === "length" || fr === "max_tokens";

    onProgress?.(
      `本轮完成，累计 ${totalLines} 行文档 / 目标 ${MIN_LINES} 行${lastTruncated ? "（因长度截断，将自动接续）" : ""}`
    );

    if (totalLines >= MIN_LINES) break;
  }

  if (!allText.trim()) throw new Error("AI 未返回任何内容");

  const finalLines = countNonEmptyLines(allText);
  if (opts.projectId) {
    if (finalLines >= MIN_LINES) {
      clearManualDraft(opts.projectId);
    } else {
      persist(false);
    }
  }

  if (finalLines < Math.min(400, MIN_LINES / 2)) {
    throw new Error(
      `说明书过短（仅 ${finalLines} 行文档），已保存草稿，请点击“从断点继续”重试`
    );
  }

  return allText;
}
