import { getAIBaseUrl, getAIModel, getActiveProvider, type AIProtocol } from "@/lib/storage";

interface ProviderConfig {
  protocol: AIProtocol;
  apiKey: string;
  baseUrl: string;
  model: string;
}

const SOFT_COPYRIGHT_COMPLIANCE_RULES = `软著申报合规用语要求：
- 申报材料只描述软件功能、技术架构、操作流程和数据管理能力。
- 涉及信俗、民俗、传统文化、节庆或非遗内容时，统一采用“民俗文化”“传统文化资料”“文化资源展示”“文化活动信息管理”等中性表述。
- 涉及“妈祖信俗”“妈祖祭典”时，按非物质文化遗产、社会实践、仪式、节庆活动和民俗文化资料处理；可写“妈祖信俗文化”“妈祖民俗文化资料”“妈祖文化活动信息管理”，不得写成“妈祖宗教文化”“妈祖宗教活动”“互联网宗教信息服务”。
- 不得写成互联网宗教信息服务、宗教活动组织、传教、宗教教育培训、讲经讲道、宗教仪式直播/录播、发展信徒、宗教募捐或宗教商业宣传。
- 不得宣称祈福改运、消灾解厄、灵验、开光加持、算命占卜等功效；不要引导用户参与宗教仪式或购买宗教服务。`;

const SOFT_COPYRIGHT_TERM_REPLACEMENTS: Array<[RegExp, string]> = [
  [/妈祖宗教信仰文化/g, "妈祖信俗文化"],
  [/妈祖宗教文化/g, "妈祖信俗文化"],
  [/妈祖信仰文化/g, "妈祖信俗文化"],
  [/妈祖宗教活动/g, "妈祖民俗文化活动"],
  [/妈祖宗教仪式/g, "妈祖民俗仪式"],
  [/妈祖宗教信息服务/g, "妈祖信俗文化资料服务"],
  [/妈祖信仰服务/g, "妈祖信俗文化服务"],
  [/妈祖信仰/g, "妈祖信俗"],
  [/宗教信仰文化/g, "民俗文化"],
  [/信仰文化/g, "民俗文化"],
  [/宗教文化传播/g, "传统文化资料展示"],
  [/传教/g, "文化资料展示"],
  [/讲经讲道/g, "文化资料讲解"],
  [/宗教教育培训/g, "文化知识学习"],
  [/宗教活动组织/g, "文化活动信息管理"],
  [/宗教仪式直播/g, "文化活动影像展示"],
  [/宗教仪式录播/g, "文化活动影像展示"],
  [/发展信徒/g, "用户服务"],
  [/发展教徒/g, "用户服务"],
  [/宗教募捐/g, "公益信息管理"],
  [/宗教商业宣传/g, "文化资源介绍"],
  [/祈福改运/g, "民俗文化体验"],
  [/消灾解厄/g, "民俗文化体验"],
  [/开光加持/g, "民俗工艺展示"],
  [/算命占卜/g, "民俗文化内容展示"],
  [/灵验/g, "文化特色"],
];

export function sanitizeSoftCopyrightText(text: string): string {
  let next = text;
  for (const [pattern, replacement] of SOFT_COPYRIGHT_TERM_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  return next;
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
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

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
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

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
  /** Resume from this chapter index (0-based) */
  resumeChapterIndex?: number;
  onProgress?: (msg: string) => void;
  /**
   * Soft target for total non-empty doc lines across all chapters.
   * NOT source-code line count.
   */
  minLines?: number;
}

const MANUAL_CHAPTERS: Array<{ title: string; outline: string; minLines: number }> = [
  {
    title: "第一章 软件概述",
    outline: "编写背景与建设意义、目标用户与使用场景、核心功能列表、总体技术架构、术语表、版本历史概览",
    minLines: 180,
  },
  {
    title: "第二章 运行环境",
    outline: "硬件要求（CPU/内存/磁盘/显示器）、支持的操作系统、软件依赖与运行时、网络与端口、权限与安全要求、推荐配置与最低配置对照表",
    minLines: 160,
  },
  {
    title: "第三章 软件安装与卸载",
    outline: "安装前准备、Windows 安装步骤、Linux 安装步骤、macOS 安装步骤、Docker/容器部署、环境变量与配置文件、升级安装、完整卸载步骤、安装验证",
    minLines: 200,
  },
  {
    title: "第四章 快速入门",
    outline: "首次启动、注册/登录（如有）、主界面分区说明、常用入口与导航、第一个完整操作示例、快捷键与基础设置",
    minLines: 180,
  },
  {
    title: "第五章 功能模块详细说明",
    outline: "至少 8 个功能模块；每个模块含：功能说明、前置条件、界面说明、逐步操作（步骤1/2/3…）、结果确认、注意事项、[图X-X：描述] 占位",
    minLines: 350,
  },
  {
    title: "第六章 常见问题与解答",
    outline: "至少 20 条 Q&A，覆盖安装、登录、配置、性能、兼容性、数据、权限、网络；每条回答至少 3 句话",
    minLines: 220,
  },
  {
    title: "第七章 错误代码与处理方法",
    outline: "至少 12 个错误码表：错误码、含义、可能原因、处理步骤、预防建议",
    minLines: 160,
  },
  {
    title: "第八章 版本更新说明",
    outline: "版本号规则、历史版本更新摘要、升级注意事项、回滚建议、维护与技术支持说明",
    minLines: 120,
  },
];

function stripModelFences(text: string): string {
  return text
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function chapterAlreadyPresent(allText: string, title: string): boolean {
  const bare = title.replace(/^第[一二三四五六七八九十\d]+章\s*/, "").trim();
  const re = new RegExp(`^#\\s+.*${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m");
  return re.test(allText) || allText.includes(`# ${title}`);
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
  const { saveManualDraft, clearManualDraft, getManualDraft } = await import("@/lib/storage");

  const contextBlock = `软件信息：
- 名称：${softwareName} ${version}
- 用途：${meta.purpose || "未填写"}
- 领域：${meta.domain || "通用"}
- 主要功能：${meta.mainFeatures || "见代码结构"}
- 技术特点：${meta.technicalFeatures || "见代码摘要"}
- 运行平台：${meta.runPlatform || "跨平台"}
- 运行环境：${meta.runSupport || "见依赖"}
- 编程语言：${languages || "未知"}
- 仓库描述：${repoDescription || "无"}

代码结构（节选）：
${fileTree.slice(0, 2500)}

代码摘要（节选）：
${codeSummary.slice(0, 3000)}`;

  const systemPrompt = `你是中国软件著作权「文档鉴别材料/操作说明书」撰写专家。
规则：
1. 只输出 Markdown 正文，不要输出目录，不要输出 JSON，不要用代码围栏包裹全文
2. 使用正式中文说明文风，内容具体可操作，避免空话套话
3. 一级标题必须使用给定的章节标题（以 # 开头）
4. 可用 ## / ### 作为小节；图片用 [图章号-序号：描述] 占位
5. 本请求只写当前这一章，不要写其他章，不要重复已写章节
6. 一次尽量写完整、详实（目标约 200–400 行文档），不要只写一两百字就结束
${SOFT_COPYRIGHT_COMPLIANCE_RULES}`;

  let allText = opts.resumeMarkdown || "";
  let startChapter = opts.resumeChapterIndex ?? 0;
  let attempt = opts.resumeAttempt || 0;

  if (!allText && opts.projectId) {
    const draft = getManualDraft(opts.projectId);
    if (draft?.markdown && !draft.complete) {
      allText = draft.markdown;
      startChapter = draft.nextChapterIndex ?? 0;
      attempt = draft.attempt || 0;
      onProgress?.(
        `发现未完成说明书草稿（${draft.lines || countNonEmptyLines(allText)} 行，第 ${startChapter + 1}/${MANUAL_CHAPTERS.length} 章起续写）...`
      );
    }
  }

  // If resuming mid-doc without chapter index, infer next chapter
  if (allText && (opts.resumeChapterIndex == null)) {
    let inferred = 0;
    for (let i = 0; i < MANUAL_CHAPTERS.length; i++) {
      if (chapterAlreadyPresent(allText, MANUAL_CHAPTERS[i].title)) inferred = i + 1;
    }
    startChapter = Math.max(startChapter, Math.min(inferred, MANUAL_CHAPTERS.length));
  }

  const persist = (nextChapterIndex: number, complete = false) => {
    if (!opts.projectId) return;
    if (!allText.trim()) return;
    saveManualDraft({
      projectId: opts.projectId,
      softwareName,
      version,
      markdown: allText,
      lines: countNonEmptyLines(allText),
      attempt,
      updatedAt: new Date().toISOString(),
      complete,
      nextChapterIndex,
    });
  };

  for (let ci = startChapter; ci < MANUAL_CHAPTERS.length; ci++) {
    const chapter = MANUAL_CHAPTERS[ci];
    if (chapterAlreadyPresent(allText, chapter.title) && countNonEmptyLines(extractChapter(allText, chapter.title)) >= chapter.minLines * 0.6) {
      onProgress?.(`第 ${ci + 1}/${MANUAL_CHAPTERS.length} 章已存在且较完整，跳过：${chapter.title}`);
      continue;
    }

    onProgress?.(
      `正在生成 ${chapter.title}（${ci + 1}/${MANUAL_CHAPTERS.length}）... 已累计 ${countNonEmptyLines(allText)} 行文档`
    );

    const userPrompt = `请只撰写以下这一章的完整 Markdown（不要目录、不要其它章）：

# ${chapter.title}

本章应覆盖：${chapter.outline}

${contextBlock}

硬性要求：
- 首行必须是：# ${chapter.title}
- 正文不少于约 ${chapter.minLines} 行（非空行），内容详实
- 每段至少 3–5 句；操作类内容必须有步骤编号
- 不要输出「目录」
- 不要重复已经生成过的章节
- 不要用 \`\`\`markdown 包裹全文`;

    // Allow multi-turn continuation *within the same chapter* if truncated/short
    let chapterText = "";
    let innerRound = 0;
    const MAX_INNER = 4;

    while (innerRound < MAX_INNER) {
      innerRound++;
      attempt++;
      const messages =
        chapterText.trim().length === 0
          ? [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ]
          : [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
              { role: "assistant", content: chapterText.slice(-10000) },
              {
                role: "user",
                content: `本章目前约 ${countNonEmptyLines(chapterText)} 行，目标约 ${chapter.minLines} 行。请紧接上文继续写本章剩余内容，不要重复已写小节，不要开始下一章。`,
              },
            ];

      try {
        const { text, finishReason } = await callAILongWithRetry(
          messages,
          onProgress,
          `${chapter.title}`
        );
        const piece = stripModelFences(text);
        if (!piece.trim()) {
          onProgress?.(`${chapter.title} 本轮空响应，重试内轮 ${innerRound}/${MAX_INNER}...`);
          continue;
        }
        if (!chapterText) chapterText = piece;
        else {
          const tail = chapterText.slice(-180);
          chapterText += tail && piece.startsWith(tail) ? piece.slice(tail.length) : `\n${piece}`;
        }

        const lines = countNonEmptyLines(chapterText);
        const truncated =
          finishReason.toLowerCase() === "length" ||
          finishReason.toLowerCase() === "max_tokens";
        onProgress?.(
          `${chapter.title} 已写 ${lines} 行${truncated ? "（截断，继续本分章）" : ""}`
        );
        if (!truncated && lines >= chapter.minLines * 0.75) break;
        if (!truncated && lines >= 80 && innerRound >= 2) break;
      } catch (e) {
        // Save progress including partial chapter
        const partial = [allText, chapterText].filter(Boolean).join("\n\n").trim();
        allText = partial;
        persist(ci, false);
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `说明书生成中断于「${chapter.title}」（已保存草稿 ${countNonEmptyLines(allText)} 行，可从断点继续）：${msg}`
        );
      }
    }

    if (!chapterText.trim()) {
      persist(ci, false);
      throw new Error(`「${chapter.title}」未生成有效内容（已保存草稿，可从断点继续）`);
    }

    // Ensure chapter heading exists once
    if (!/^#\s+/.test(chapterText.trim())) {
      chapterText = `# ${chapter.title}\n\n${chapterText}`;
    }

    allText = [allText.trim(), chapterText.trim()].filter(Boolean).join("\n\n") + "\n\n";
    persist(ci + 1, false);
    onProgress?.(
      `完成 ${chapter.title} · 累计 ${countNonEmptyLines(allText)} 行文档（${ci + 1}/${MANUAL_CHAPTERS.length}）`
    );
  }

  if (!allText.trim()) throw new Error("AI 未返回任何内容");

  // Light global top-up only if still extremely short (should be rare with chapter mode)
  const total = countNonEmptyLines(allText);
  const softTarget = opts.minLines ?? 1500;
  if (total < softTarget * 0.5) {
    onProgress?.(`总行数偏少（${total}），尝试补充第五章细节...`);
    try {
      const { text } = await callAILongWithRetry(
        [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `在不重复已有章节标题的前提下，为《${softwareName}》补充「功能模块」操作细节（Markdown）。\n\n已有文末：\n${allText.slice(-5000)}\n\n请输出补充内容（## 小节即可），约 300 行。`,
          },
        ],
        onProgress,
        "补充内容"
      );
      const extra = stripModelFences(text);
      if (extra.trim()) allText += `\n\n${extra}\n`;
    } catch {
      /* keep what we have */
    }
  }

  if (opts.projectId) {
    clearManualDraft(opts.projectId);
  }

  return sanitizeSoftCopyrightText(allText.trim()) + "\n";
}

function extractChapter(allText: string, title: string): string {
  const bare = title.replace(/^第[一二三四五六七八九十\d]+章\s*/, "").trim();
  const lines = allText.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#\s+/.test(t) && !/^##\s+/.test(t) && (t.includes(bare) || t.includes(title))) {
      start = i;
      break;
    }
  }
  if (start < 0) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#\s+/.test(t) && !/^##\s+/.test(t)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
