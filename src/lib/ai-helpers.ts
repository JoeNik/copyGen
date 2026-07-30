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
- 不得宣称祈福改运、消灾解厄、灵验、开光加持、算命占卜等功效；不要引导用户参与宗教仪式或购买宗教服务。
- 代码目录或组件名中若出现 fortune、bazi、divination、fengshui、qiufu 等含义的命名，不要按字面写成命理、八字、占卜、风水、求签等功能；应统一表述为「民俗文化资料展示」「传统文化知识查询」等中性功能，或不纳入本次申报范围。`;

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
  // Divination-flavoured module names leak in from real directory names
  // (FortuneBazi*, Fortune*), and 软著 review treats them as prohibited content.
  // Compound terms first — the list is applied in order.
  [/生辰八字/g, "民俗文化资料"],
  [/八字命理/g, "民俗文化资料"],
  [/命理分析/g, "民俗文化资料展示"],
  [/命理/g, "民俗文化"],
  [/八字/g, "民俗文化"],
  [/风水/g, "民俗文化"],
  [/求签/g, "民俗文化互动"],
  [/抽签/g, "民俗文化互动"],
  [/占卜/g, "民俗文化内容展示"],
];

export function sanitizeSoftCopyrightText(text: string): string {
  let next = text;
  for (const [pattern, replacement] of SOFT_COPYRIGHT_TERM_REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

/**
 * Send an AI request through the service-worker proxy (avoids CORS), falling back
 * to a direct request when no worker is controlling the page — on a hard reload or
 * the very first visit the SW may not have claimed the client yet, and hitting
 * `/__ai_proxy__` unproxied returns the Next.js 404 HTML, which surfaced as an
 * unexplained failure.
 */
async function proxyFetch(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.stringify({
    targetUrl: url,
    method: init.method || "POST",
    headers: init.headers,
    body: init.body,
  });

  const controlled =
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    !!navigator.serviceWorker.controller;

  if (controlled) {
    const res = await fetch("/__ai_proxy__", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // The proxy always tags its responses; anything else means the request escaped
    // the worker (404 HTML from the app router) → retry directly.
    if (res.headers.get("X-AI-Proxy") || res.status !== 404) return res;
  }

  return fetch(url, init);
}

/** Ensure the AI proxy worker is active before the first request of a batch. */
export async function ensureAIProxyReady(timeoutMs = 3000): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  if (navigator.serviceWorker.controller) return true;
  try {
    await navigator.serviceWorker.ready;
  } catch {
    return false;
  }
  if (navigator.serviceWorker.controller) return true;

  // `ready` resolves once registered, but control of an already-loaded page only
  // arrives with controllerchange. Wait briefly, then fall back to direct fetch.
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(!!navigator.serviceWorker.controller);
    }, timeoutMs);
    const onChange = () => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      resolve(true);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
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

async function callAI(
  messages: { role: string; content: string }[],
  config: ProviderConfig,
  maxTokens = 200
): Promise<string> {
  let url: string;
  let headers: Record<string, string>;
  let body: string;

  if (config.protocol === "openai") {
    url = openaiChatCompletionsUrl(config.baseUrl);
    headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
    body = JSON.stringify({ model: config.model, max_tokens: maxTokens, messages });
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
      max_tokens: maxTokens,
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
    body = JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } });
  }

  const res = await proxyFetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`AI API 错误 (${res.status}): ${err.slice(0, 200)}`);
  }
  const { text } = await parseAIResponse(res, config.protocol);
  return text.trim();
}

/**
 * Short-answer AI call. `maxTokens` defaults to 200 for one-line answers (name,
 * category); pass a larger budget for JSON payloads — 200 tokens truncates a
 * six-field Chinese JSON object mid-string and the parse silently fails.
 */
export async function callAIForText(prompt: string, maxTokens = 200): Promise<string> {
  const active = getActiveProvider();
  if (!active) throw new Error("请先在设置中配置并启用一个 AI 提供商");
  const config: ProviderConfig = {
    protocol: active.protocol,
    apiKey: active.apiKey,
    baseUrl: active.baseUrl || getAIBaseUrl(),
    model: active.model || getAIModel(),
  };
  return callAI([{ role: "user", content: prompt }], config, maxTokens);
}

/**
 * Robustly pull the first JSON object out of a model response that may be
 * fenced, prefixed with prose, or followed by trailing text.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const stripped = stripModelFences(text);
  // Try direct parse first
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  // Find the outermost balanced { ... }
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as Record<string, unknown>;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ── AI review: project metadata sanity check ──

export interface MetaReviewIssue {
  /** SoftwareMeta key or a human field name */
  field: string;
  /** 中文字段名，便于展示 */
  fieldLabel: string;
  /** 问题类型：区分“漏了内容”和“写错了” */
  kind: "错误" | "遗漏" | "不一致" | "规范";
  severity: "high" | "medium" | "low";
  /** 现值有什么问题 */
  problem: string;
  /** 建议改成什么 — 完整的可替换文本 */
  suggestion: string;
}

export interface MetaReviewResult {
  issues: MetaReviewIssue[];
  /** AI 从 README/目录结构中识别出的项目实际能力 */
  detectedCapabilities: string[];
  /** 上述能力中未被「主要功能」覆盖的部分 */
  missingFromMainFeatures: string[];
  overallComment: string;
}

const META_FIELD_LABELS: Record<string, string> = {
  softwareName: "软件全称",
  version: "版本号",
  category: "软件分类",
  purpose: "开发目的",
  domain: "面向领域/行业",
  mainFeatures: "主要功能",
  technicalFeatures: "技术特点",
  softwareDescription: "软件说明",
  runPlatform: "运行平台",
  runSupport: "运行支撑环境",
  devTools: "开发工具",
  devHardware: "开发硬件环境",
  runHardware: "运行硬件环境",
  devOS: "开发操作系统",
  languagesGiven: "编程语言（给定项）",
  languagesExtra: "编程语言（补充项）",
  techCategoriesGiven: "技术特点分类",
  techCategoriesExtra: "技术特点（补充）",
  sourceLines: "源程序行数",
  originalType: "原创/修改",
  devMethod: "开发方式",
  publishStatus: "发表状态",
};

export function buildMetaReviewPrompt(input: {
  softwareName: string;
  version: string;
  repoName: string;
  repoDescription: string;
  languages: string;
  fileTree: string;
  readme?: string;
  moduleDirs?: string;
  meta: Record<string, unknown>;
}): string {
  return `你是中国计算机软件著作权登记材料的审核专家。下面是一个软件项目的登记信息，请逐项核对是否存在填写错误、遗漏、前后矛盾、与仓库实际情况不符、或不符合软著登记规范的地方。

核对要求：
- 只依据下方提供的 README、语言统计、目录结构等客观事实，不要凭空想象仓库里没有的东西。
- 软件全称应以“软件”“系统”“平台”等结尾，不含版本号；版本号形如 V1.0。
- 运行平台/运行支撑环境/编程语言应与语言统计、依赖清单一致（例如 Node/前端项目不应写成仅 Windows 桌面 exe）。这几项不一致是形式审查能发现的硬问题，优先级最高。
- 开发目的、主要功能、技术特点、软件说明应彼此一致，且与 README、目录结构不矛盾。

【必须逐项检查功能覆盖是否完整】这是本次核对的重点：
- 请先从 README 与目录结构中列出该项目实际具备的能力清单，再与「主要功能」逐条比对。
- 如果实际具备的能力中有 3 条以上未被「主要功能」涵盖，必须针对 mainFeatures 提出 issue，类型为“遗漏”。
- 「主要功能」的建议内容必须是**完整的最终文本**：保留原有仍然正确的功能项，并补齐遗漏的功能项，合并为 4-8 条、分号分隔的完整列表，可直接替换原值。不要只写新增的部分。
- 同样检查「开发目的」「技术特点」「软件说明」是否遗漏了项目的重要特征（例如支持的关键技术、面向的关键场景）；若有遗漏，也按“遗漏”提出，并给出补全后的完整文本。
- 软著登记材料使用概括性的常规表述是正常的：不要因为“不够详细/不够独特”而报问题。判断标准是**能力有没有被覆盖到**，而不是描述得多细。

其他原则：
- 每个 issue 的 kind 取值：“错误”（与实际不符）、“遗漏”（缺少应有内容）、“不一致”（字段之间互相矛盾）、“规范”（不符合软著用语规范）。
- suggestion 一律给出可直接替换原值的完整最终文本，不要写“建议改为……”这类前缀，不要只给增量。
- 若某字段确实合理、无需修改，就不要为它编造问题。
- 若仓库中存在不适合写入软著申报材料的模块（例如命名涉及命理、占卜、风水、求签的目录），不要建议把它写进「主要功能」；如确需覆盖，请改用「民俗文化资料展示」这类中性表述。
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

仓库名称：${input.repoName}
仓库描述：${input.repoDescription || "无"}
语言统计（按代码字节占比）：${input.languages || "未知"}

README（节选）：
${input.readme ? input.readme.slice(0, 4000) : "（无 README）"}

目录结构（模块划分）：
${(input.moduleDirs || input.fileTree).slice(0, 2000)}

代表性源文件：
${input.fileTree.slice(0, 1500)}

当前填写的登记信息（JSON）：
${JSON.stringify({ softwareName: input.softwareName, version: input.version, ...input.meta }, null, 2)}

只返回如下 JSON（不要输出解释、不要代码围栏）。没有问题时 issues 返回空数组：
{
  "detectedCapabilities": ["从 README 和目录结构中识别出的该项目实际能力，若干条"],
  "missingFromMainFeatures": ["上述能力中未被「主要功能」涵盖的条目，若无则空数组"],
  "issues": [
    {
      "field": "上面 JSON 中的字段英文 key（如 mainFeatures、purpose、runPlatform、softwareName）",
      "kind": "错误 | 遗漏 | 不一致 | 规范",
      "severity": "high | medium | low",
      "problem": "该字段现在的问题（一句话）",
      "suggestion": "可直接替换原值的完整最终文本"
    }
  ],
  "overallComment": "对整体填写质量的一句话总评"
}`;
}

export async function reviewProjectMeta(input: {
  softwareName: string;
  version: string;
  repoName: string;
  repoDescription: string;
  languages: string;
  fileTree: string;
  readme?: string;
  moduleDirs?: string;
  meta: Record<string, unknown>;
}): Promise<MetaReviewResult> {
  const text = await callAILongJSON(
    [{ role: "user", content: buildMetaReviewPrompt(input) }],
    "AI 核对"
  );
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("AI 未返回可解析的核对结果，请重试");
  }
  const rawIssues = Array.isArray(parsed.issues) ? parsed.issues : [];
  const issues: MetaReviewIssue[] = rawIssues
    .map((it) => it as Record<string, unknown>)
    .filter((it) => it && typeof it.field === "string")
    .map((it) => {
      const field = String(it.field);
      const sevRaw = String(it.severity || "medium");
      const severity: "high" | "medium" | "low" =
        sevRaw === "high" ? "high" : sevRaw === "low" ? "low" : "medium";
      const kindRaw = String(it.kind || "").trim();
      const kind: MetaReviewIssue["kind"] =
        kindRaw === "遗漏" || kindRaw === "不一致" || kindRaw === "规范" ? kindRaw : "错误";
      return {
        field,
        fieldLabel: META_FIELD_LABELS[field] || field,
        kind,
        severity,
        problem: sanitizeSoftCopyrightText(String(it.problem || "")),
        suggestion: sanitizeSoftCopyrightText(String(it.suggestion || "")),
      };
    })
    .filter((it) => it.problem || it.suggestion);

  const toStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((s) => sanitizeSoftCopyrightText(String(s))).filter(Boolean) : [];

  return {
    issues,
    detectedCapabilities: toStringList(parsed.detectedCapabilities),
    missingFromMainFeatures: toStringList(parsed.missingFromMainFeatures),
    overallComment: sanitizeSoftCopyrightText(String(parsed.overallComment || "")),
  };
}

// ── AI review: generated manual audit (hallucination / consistency / 软著 pass) ──

export interface ManualAuditFinding {
  severity: "high" | "medium" | "low";
  category: string;
  /** 出现问题的章节或位置描述 */
  location: string;
  /**
   * Verbatim heading line of the section the problem lives in, e.g.
   * "## 2.4 网络与端口". Used to locate the exact text to rewrite; empty when the
   * model couldn't point at one heading.
   */
  anchor: string;
  problem: string;
  suggestion: string;
}

export interface ManualAuditResult {
  /** 0–100 文档质量总评 */
  score: number;
  /** 软著文档鉴别材料初步通过概率 0–100 */
  passProbability: number;
  summary: string;
  /** 疑似与代码不符/编造的内容 */
  findings: ManualAuditFinding[];
  /** 亮点/合格项 */
  strengths: string[];
}

export function buildManualAuditPrompt(input: {
  softwareName: string;
  version: string;
  meta: Record<string, unknown>;
  languages: string;
  fileTree: string;
  codeSummary: string;
  markdown: string;
}): string {
  // Keep well within the model context; audit a representative slice.
  const doc = input.markdown.length > 24000 ? input.markdown.slice(0, 24000) + "\n…（文档过长已截断）" : input.markdown;
  return `你是中国计算机软件著作权“文档鉴别材料（操作说明书）”的审核专家。请审核下面这份 AI 生成的操作说明书，重点判断：
1. 可用性/一致性：文档描述的功能、界面、操作流程是否与该软件的实际信息（仓库结构、编程语言、主要功能）一致，是否自相矛盾。
2. 幻觉/编造：是否出现代码或项目信息中并不存在的功能、模块、错误码、平台、依赖（这是最严重的问题）。
3. 软著规范：是否符合软著文档鉴别材料要求（正式说明文风、面向操作、图占位合理、不含营销/宣传/敏感表述），并给出“初步判定通过概率”。
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

审核原则：
- 只依据下方提供的客观信息判断“是否编造”，如果文档写了下方信息里完全没有依据的具体功能/模块/错误码，判为疑似幻觉。
- 软著说明书使用概括、程式化的表述属于正常且符合惯例，不要因为“不够详细/不够独特”而扣分或报问题。审核重点是内部矛盾与凭空编造，不是文采或信息密度。
- 章节之间的自相矛盾（例如第五章的模块名与第六、七章不对应）比表述笼统严重得多，应优先指出。
- 结构性重复（同一章标题或同一小节出现两次以上）属于严重问题，必须单独指出并注明重复的标题。
- 幻觉判定要具体到“编造了什么”：编程语言、端口号、脚本/可执行文件名、精确版本号、第三方库名、硬件型号，这几类只要文档写了而下方信息中无依据，就应指出。
- 反过来，仓库里存在但说明书没写到的目录/组件，**不一定**是问题：说明书覆盖的是本次登记的功能范围，未纳入本版本的模块可以不写。只有当缺失的模块属于登记信息「主要功能」列出的内容时，才按“完整性”提出。
- 不要自己臆造问题；无法确定的从轻。
- score（文档质量）与 passProbability（软著初步通过概率）都用 0–100 整数。

软件名称：${input.softwareName} ${input.version}
编程语言：${input.languages || "未知"}
登记信息（JSON）：
${JSON.stringify(input.meta, null, 2)}
仓库目录结构（节选）：
${input.fileTree.slice(0, 2000)}
代码摘要（节选）：
${input.codeSummary.slice(0, 2500)}

待审核的说明书（Markdown，可能已截断）：
"""
${doc}
"""

只返回如下 JSON（不要解释、不要代码围栏）：
{
  "score": 0-100,
  "passProbability": 0-100,
  "summary": "整体结论（2-3句）：是否可用、主要风险",
  "findings": [
    {
      "severity": "high | medium | low",
      "category": "幻觉 | 一致性 | 软著规范 | 完整性 | 结构 | 其它",
      "location": "问题所在章节或小节（可读描述）",
      "anchor": "该问题所在小节的标题原文，必须与文档中的某一行完全一致（含 # 号），例如「## 2.4 网络与端口」；若问题跨越整章则填该章的一级标题原文；实在无法定位时填空字符串",
      "problem": "具体问题",
      "suggestion": "如何修改"
    }
  ],
  "strengths": ["合格/亮点项，若干条"]
}

关于 anchor 的要求（很重要，后续会按它定位并自动修订该段落）：
- 必须从上面文档中原样复制标题行，包括 ## 符号、编号和空格，不要自己改写或加引号。
- 一个 finding 只对应一个 anchor。如果同一类问题散布在多个小节，请拆成多个 finding。`;
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export async function auditManualMarkdown(input: {
  softwareName: string;
  version: string;
  meta: Record<string, unknown>;
  languages: string;
  fileTree: string;
  codeSummary: string;
  markdown: string;
}): Promise<ManualAuditResult> {
  const text = await callAILongJSON(
    [{ role: "user", content: buildManualAuditPrompt(input) }],
    "AI 审核"
  );
  const parsed = extractJsonObject(text);
  if (!parsed) {
    throw new Error("AI 未返回可解析的审核结果，请重试");
  }
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
  const findings: ManualAuditFinding[] = rawFindings
    .map((it) => it as Record<string, unknown>)
    .filter(Boolean)
    .map((it) => {
      const sevRaw = String(it.severity || "medium");
      const severity: "high" | "medium" | "low" =
        sevRaw === "high" ? "high" : sevRaw === "low" ? "low" : "medium";
      return {
        severity,
        category: sanitizeSoftCopyrightText(String(it.category || "其它")),
        location: sanitizeSoftCopyrightText(String(it.location || "")),
        // Not sanitized: it must match the document byte-for-byte to locate the section.
        anchor: typeof it.anchor === "string" ? it.anchor.trim() : "",
        problem: sanitizeSoftCopyrightText(String(it.problem || "")),
        suggestion: sanitizeSoftCopyrightText(String(it.suggestion || "")),
      };
    })
    .filter((it) => it.problem || it.suggestion);
  const strengths = Array.isArray(parsed.strengths)
    ? parsed.strengths.map((s) => sanitizeSoftCopyrightText(String(s))).filter(Boolean)
    : [];
  return {
    score: clampScore(parsed.score),
    passProbability: clampScore(parsed.passProbability),
    summary: sanitizeSoftCopyrightText(String(parsed.summary || "")),
    findings,
    strengths,
  };
}

// ── Targeted revision: rewrite just the section an audit finding points at ──

export interface LocatedSection {
  /** Heading line as it appears in the document. */
  heading: string;
  /** Full section text, heading line included. */
  text: string;
  /** Character offsets into the document. */
  start: number;
  end: number;
  /** How the section was found — surfaced so the user can sanity-check it. */
  matchedBy: "exact" | "normalized" | "contains";
}

/**
 * Find the section a finding's `anchor` refers to.
 *
 * Three passes, loosening in turn: byte-identical heading line, then the heading
 * with numbering/punctuation/whitespace stripped, then substring containment.
 * A section runs from its heading up to the next heading of the same or higher
 * level, so rewriting it can't swallow sibling sections.
 */
export function locateSection(markdown: string, anchor: string): LocatedSection | null {
  const target = anchor.trim();
  if (!target) return null;

  const lines = markdown.split("\n");
  const targetKey = headingKey(target);
  if (!targetKey) return null;

  const headings: { index: number; line: string; level: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i]);
    if (m) headings.push({ index: i, line: lines[i], level: m[1].length });
  }
  if (!headings.length) return null;

  const passes: Array<{ by: LocatedSection["matchedBy"]; test: (line: string) => boolean }> = [
    { by: "exact", test: (line) => line.trim() === target },
    { by: "normalized", test: (line) => headingKey(line) === targetKey },
    {
      by: "contains",
      test: (line) => {
        const key = headingKey(line);
        return key.length > 0 && (key.includes(targetKey) || targetKey.includes(key));
      },
    },
  ];

  for (const pass of passes) {
    const hit = headings.find((h) => pass.test(h.line));
    if (!hit) continue;
    // End at the next heading that is not nested inside this one.
    const next = headings.find((h) => h.index > hit.index && h.level <= hit.level);
    const endLine = next ? next.index : lines.length;
    const start = lines.slice(0, hit.index).reduce((n, l) => n + l.length + 1, 0);
    const text = lines.slice(hit.index, endLine).join("\n").replace(/\s+$/, "");
    return {
      heading: hit.line.trim(),
      text,
      start,
      end: start + text.length,
      matchedBy: pass.by,
    };
  }
  return null;
}

/** Replace a located section's text in the document. */
export function replaceSection(markdown: string, section: LocatedSection, replacement: string): string {
  const before = markdown.slice(0, section.start);
  const after = markdown.slice(section.end);
  return before + replacement.replace(/\s+$/, "") + after;
}

export function buildSectionRevisionPrompt(input: {
  softwareName: string;
  version: string;
  meta: Record<string, unknown>;
  languages: string;
  fileTree: string;
  /** Section headings elsewhere in the document — keeps naming consistent. */
  documentOutline: string;
  sectionText: string;
  problem: string;
  suggestion: string;
}): string {
  return `你是中国软件著作权「文档鉴别材料/操作说明书」撰写专家。下面给出说明书中的**一个小节**，以及审核指出的问题。请按审核意见重写这个小节。

硬性要求：
- 只输出重写后的这一个小节的 Markdown，**首行必须是原来的标题行，一字不改**。
- 不要输出其它小节，不要输出说明、前言、结语，不要用代码围栏包裹。
- 保持原有的标题层级与编号；小节内部可以增删 ### 子标题和段落。
- 篇幅与原文相当或略多，不要大幅缩短（软著文档鉴别材料需要足够篇幅）。
- 只修正审核指出的问题，其余正确内容尽量保留原样，避免引入新的不一致。

【严禁编造具体事实】没有依据时必须改用概括表述：
- 编程语言只能使用下面「编程语言」中列出的；不要自行添加其它语言。
- 端口号、IP、数据库名、精确版本号：改写为「按部署环境配置的服务端口」「参见运行支撑环境要求」这类表述。
- 安装脚本名、可执行文件名、具体命令：改写为「运行安装程序」「执行项目提供的启动命令」这类表述。
- 第三方库名、协议名、硬件型号：同上。
- 功能模块名必须与「主要功能」以及下面的文档大纲一致，不要另起名字。
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

软件名称：${input.softwareName} ${input.version}
编程语言：${input.languages || "未知"}
登记信息（JSON）：
${JSON.stringify(input.meta, null, 2)}
仓库目录结构（节选）：
${input.fileTree.slice(0, 1500)}

全文小节大纲（重写时沿用这些名称，不要与之矛盾）：
${input.documentOutline.slice(0, 2500) || "（无）"}

审核指出的问题：${input.problem}
审核给出的修改建议：${input.suggestion}

需要重写的小节原文：
"""
${input.sectionText.slice(0, 12000)}
"""`;
}

/**
 * Rewrite one section per an audit finding. Returns the new section text with its
 * original heading restored — the model is asked to keep it, but a changed heading
 * would break the anchor for any later finding, so it's enforced here too.
 */
export async function reviseSection(input: {
  softwareName: string;
  version: string;
  meta: Record<string, unknown>;
  languages: string;
  fileTree: string;
  documentOutline: string;
  section: LocatedSection;
  problem: string;
  suggestion: string;
}): Promise<string> {
  const { text } = await callAILongWithRetry(
    [{ role: "user", content: buildSectionRevisionPrompt({ ...input, sectionText: input.section.text }) }],
    undefined,
    "AI 修订小节"
  );
  let revised = stripModelFences(text).trim();
  if (!revised) throw new Error("AI 未返回修订内容，请重试");

  // Force the original heading back on: drop a leading heading line (whatever the
  // model produced) and prepend the real one.
  const firstLine = revised.split("\n", 1)[0] ?? "";
  if (/^#{1,6}\s+/.test(firstLine.trim())) {
    revised = revised.slice(firstLine.length).replace(/^\n+/, "");
  }
  return sanitizeSoftCopyrightText(`${input.section.heading}\n\n${revised}`.trim());
}

/** Heading outline of a document, for continuity context in revision prompts. */
export function documentOutline(markdown: string): string {
  return markdown
    .split("\n")
    .filter((l) => /^#{1,6}\s+/.test(l.trim()))
    .map((l) => l.trim())
    .join("\n");
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

export function buildTechCategoriesPrompt(repoName: string, description: string, language: string): string {
  return `根据以下 GitHub 仓库信息，判断该软件属于哪些技术特点分类。
从以下选项中选择所有适用的（逗号分隔返回），不要返回选项之外的内容：

APP, 游戏软件, 教育软件, 金融软件, 医疗软件, 地理信息软件, 云计算软件, 信息安全软件, 大数据软件, 人工智能软件, VR软件, 5G软件, 小程序, 物联网软件, 智慧城市软件

仓库名称：${repoName}
仓库描述：${description || "无"}
主要语言：${language || "未知"}

只返回选中的分类名称，逗号分隔，不要返回其他内容。如果没有匹配的，返回"应用软件"。`;
}

export interface MetadataPromptInput {
  repoName: string;
  repoDescription: string;
  /** Human-readable Linguist breakdown, e.g. "TypeScript 78%, CSS 12%" */
  languageStats: string;
  /** Mapped 软著 given-list languages already selected */
  givenLanguages: string;
  /** README content (truncated) */
  readme: string;
  /** Dependency manifests */
  manifests: { path: string; content: string }[];
  /** Directory layout at depth 1–2 */
  moduleDirs: string[];
  /** Representative source paths */
  sourcePaths: string[];
  /** Detected build/dev tooling */
  devTools: string;
}

/**
 * Metadata prompt: grounded but conventional.
 *
 * README + manifests are included so 运行平台/运行支撑环境/编程语言 match reality —
 * those are the fields a 形式审查 can catch as internally inconsistent. The
 * descriptive fields deliberately stay in standard 软著 register: 4–6 功能要点 in
 * the conventional "XX管理/XX处理" shape, just named after what this project
 * actually does. Over-specific feature lists make the chapter-by-chapter manual
 * harder to keep self-consistent, which is a worse failure than mild generality.
 */
export function buildMetadataPrompt(input: MetadataPromptInput): string {
  const manifestBlock = input.manifests.length
    ? input.manifests
        .map((m) => `--- ${m.path} ---\n${m.content.slice(0, 1800)}`)
        .join("\n\n")
    : "（无依赖清单）";

  return `你是中国软件著作权登记材料撰写专家。请根据下面这个真实代码仓库的信息，填写软著登记所需的软件元数据。

写作要求：
- 采用软著登记材料的常规表述风格：正式、概括、面向功能，不写营销语言，不写具体代码实现细节。
- 「主要功能」写 4-6 条，每条为「XX管理」「XX处理」「XX生成」这类标准功能项表述，用分号分隔；功能项的名称要对应本项目实际具备的能力（从 README 与目录结构判断），不要套用与本项目无关的通用条目。
- 「运行平台」「运行支撑环境」「编程语言」必须与实际技术栈一致（依据依赖清单中的运行时与版本），这几项如与实际不符会在形式审查中被发现。
- 「开发目的」1-2 句，说明本软件面向的问题与目标，保持概括。
- 「技术特点」2-3 句，说明总体技术方案与架构层次，不需要列举具体库名。
- 不要编造仓库中没有依据的功能模块、平台或依赖。
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

## 仓库基本信息
名称：${input.repoName}
描述：${input.repoDescription || "无"}
GitHub 语言统计（按代码字节占比）：${input.languageStats || "未知"}
软著登记语言（已映射）：${input.givenLanguages || "未确定"}
检测到的开发工具：${input.devTools || "未检测到"}

## README（说明项目用途）
${input.readme ? input.readme.slice(0, 5000) : "（该仓库没有 README）"}

## 依赖清单（用于判断运行环境与技术栈）
${manifestBlock}

## 目录结构（模块划分）
${input.moduleDirs.join("\n").slice(0, 1500)}

## 代表性源文件
${input.sourcePaths.slice(0, 60).join("\n").slice(0, 1500)}

只返回如下 JSON，不要输出解释、不要代码围栏：
{
  "runPlatform": "运行平台/操作系统，需与技术栈一致",
  "runSupport": "运行支撑环境，写明运行时及版本（如 Node.js 18+、Python 3.10+、JDK 17）",
  "purpose": "开发目的（1-2句，概括）",
  "domain": "面向领域/行业",
  "mainFeatures": "主要功能，4-6条标准功能项表述，分号分隔",
  "technicalFeatures": "技术特点，总体技术方案与架构（2-3句）",
  "softwareDescription": "软件整体说明（2-3句，用于登记表「软件说明」栏）"
}`;
}

/**
 * Pick the registration form's 技术特点分类 using real repo evidence rather than
 * just the repo name and primary language.
 */
export function buildTechCategoriesFromInsightsPrompt(input: {
  repoName: string;
  repoDescription: string;
  readme: string;
  moduleDirs: string[];
  languageStats: string;
}): string {
  return `根据下面这个真实代码仓库的信息，判断该软件属于哪些「技术特点分类」。
只能从以下固定选项中选择（逗号分隔），不要返回选项之外的内容：

APP, 游戏软件, 教育软件, 金融软件, 医疗软件, 地理信息软件, 云计算软件, 信息安全软件, 大数据软件, 人工智能软件, VR软件, 5G软件, 小程序, 物联网软件, 智慧城市软件

判断依据要来自实际内容，不要仅凭名字猜测。若该项目调用了大模型/AI 接口，可选「人工智能软件」；若是 Web 服务/后端，可选「云计算软件」；若确实都不沾，返回 APP。

仓库名称：${input.repoName}
仓库描述：${input.repoDescription || "无"}
语言统计：${input.languageStats || "未知"}
README（节选）：
${input.readme.slice(0, 2500) || "（无）"}
目录结构：
${input.moduleDirs.join("\n").slice(0, 1000)}

只返回选中的分类名称，逗号分隔，不要返回其他内容。`;
}

/**
 * Distil a project description from the README rather than reusing GitHub's
 * one-line `description` field.
 *
 * The GitHub field is written for browsers of the repo — often a slogan, an emoji
 * string, or English shorthand — and it feeds 开发目的/主要功能 generation as well
 * as the manual prompt, so a thin or promotional value degrades everything
 * downstream. The README states what the software actually does.
 */
export function buildRepoSummaryPrompt(input: {
  repoName: string;
  githubDescription: string;
  readme: string;
  moduleDirs: string[];
  languageStats: string;
}): string {
  return `请根据下面这个真实代码仓库的 README 与目录结构，用中文提炼一段「项目描述」，供后续撰写软件著作权登记材料时参考。

要求：
- 2-4 句，先说这个软件是什么、解决什么问题，再说它主要包含哪几类能力。
- 只依据 README 与目录结构中的事实，不要编造没有依据的功能、平台或技术。
- 使用正式、客观的陈述语气；不要用「本项目是一个强大的/优雅的」这类宣传语，不要用 emoji，不要用 Markdown 标记。
- 如果 README 是英文，请输出中文。
- 只输出这段描述本身，不要输出标题、前缀或解释。
${SOFT_COPYRIGHT_COMPLIANCE_RULES}

仓库名称：${input.repoName}
GitHub 仓库描述（可能为空或为标语，仅作参考）：${input.githubDescription || "无"}
语言统计：${input.languageStats || "未知"}

README（节选）：
${input.readme.slice(0, 6000) || "（无 README）"}

目录结构（模块划分）：
${input.moduleDirs.join("\n").slice(0, 1500) || "（无）"}`;
}

/**
 * Returns a README-derived description, or "" when there's nothing to work from
 * (callers then keep whatever they already had).
 */
export async function summarizeRepoDescription(input: {
  repoName: string;
  githubDescription: string;
  readme: string;
  moduleDirs: string[];
  languageStats: string;
}): Promise<string> {
  if (!input.readme.trim() && !input.moduleDirs.length) return "";
  const text = await callAIForText(buildRepoSummaryPrompt(input), 700);
  const cleaned = text
    .replace(/^```[a-z]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^(项目描述|软件描述|描述)\s*[:：]\s*/i, "")
    .trim();
  return sanitizeSoftCopyrightText(cleaned);
}

export interface GeneratedMetadata {
  runPlatform: string;
  runSupport: string;
  purpose: string;
  domain: string;
  mainFeatures: string;
  technicalFeatures: string;
  softwareDescription: string;
}

/**
 * Generate registration metadata from repo insights. Uses the long-form endpoint
 * with a real token budget — the previous 200-token short call truncated the JSON
 * and the failure was swallowed, leaving fields blank or generic.
 */
export async function generateProjectMetadata(
  input: MetadataPromptInput
): Promise<GeneratedMetadata | null> {
  const text = await callAILongJSON(
    [{ role: "user", content: buildMetadataPrompt(input) }],
    "AI 元数据生成"
  );
  const parsed = extractJsonObject(text);
  if (!parsed) return null;
  const pick = (k: string) =>
    typeof parsed[k] === "string" ? sanitizeSoftCopyrightText(String(parsed[k])) : "";
  return {
    runPlatform: pick("runPlatform"),
    runSupport: pick("runSupport"),
    purpose: pick("purpose"),
    domain: pick("domain"),
    mainFeatures: pick("mainFeatures"),
    technicalFeatures: pick("technicalFeatures"),
    softwareDescription: pick("softwareDescription"),
  };
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

/**
 * `callAILong` for one-shot JSON requests (核对 / 审核), with the same retry policy
 * the manual generator uses. A single transient network blip previously surfaced to
 * the user as a bare "Failed to fetch".
 */
async function callAILongJSON(
  messages: { role: string; content: string }[],
  label: string
): Promise<string> {
  await ensureAIProxyReady();
  const MAX_RETRIES = 2;
  let lastError: unknown;

  for (let retry = 0; retry <= MAX_RETRIES; retry++) {
    try {
      if (retry > 0) await sleep(Math.min(8000, 1500 * 2 ** (retry - 1)));
      const { text } = await callAILong(messages);
      if (text.trim()) return text;
      lastError = new Error(`${label}返回空内容`);
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      // Auth failures and explicit API errors won't fix themselves.
      if (/AI API 错误 \((400|401|403|404|422)\)/i.test(msg)) break;
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  if (/failed to fetch|networkerror|load failed/i.test(msg)) {
    throw new Error(
      `${label}请求失败：无法连接 AI 接口。请检查网络、API 地址是否可访问（若使用反向代理请确认其允许跨域），然后重试。`
    );
  }
  throw new Error(`${label}失败：${msg}`);
}

function countNonEmptyLines(text: string): number {
  return text.split("\n").filter((l) => l.trim()).length;
}

/** Non-empty line count, exported for UI that reports dedupe results. */
export function countDocumentLines(text: string): number {
  return countNonEmptyLines(text);
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

/** Normalized heading text, for comparing sections across turns. */
function headingKey(line: string): string {
  return line.replace(/^#{1,6}\s*/, "").replace(/[\s：:、.。0-9０-９]/g, "").trim();
}

/**
 * Split markdown into blocks at `##`-or-deeper headings, keeping any text before
 * the first heading as block 0.
 */
function splitSections(text: string): { heading: string; body: string }[] {
  const lines = text.split("\n");
  const blocks: { heading: string; body: string }[] = [];
  let cur: { heading: string; body: string } = { heading: "", body: "" };
  for (const line of lines) {
    if (/^#{2,6}\s+/.test(line.trim())) {
      blocks.push(cur);
      cur = { heading: line.trim(), body: "" };
    } else {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  blocks.push(cur);
  return blocks.filter((b) => b.heading || b.body.trim());
}

/**
 * Merge a continuation turn into the chapter written so far.
 *
 * Models frequently ignore "continue from here" and re-emit the chapter from the
 * top. Blind concatenation then produces the same chapter two or three times over,
 * which reads as self-contradiction and was the single biggest quality problem in
 * generated manuals. So: drop a repeated chapter heading, trim any literal overlap,
 * and skip sections whose heading was already written.
 */
function mergeContinuation(existing: string, piece: string, title: string): string {
  if (!existing.trim()) return piece;

  let next = piece.trim();

  // A repeated top-level heading means the model restarted the chapter.
  const restarted = new RegExp(`^#\\s+.*${title.replace(/^第[一二三四五六七八九十\d]+章\s*/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(next)
    || next.startsWith(`# ${title}`);
  if (restarted) {
    next = next.replace(/^#\s+[^\n]*\n?/, "").trim();
    // If the restart is essentially the whole chapter again, keep the longer text
    // rather than stitching two overlapping versions together.
    const existingSections = new Set(splitSections(existing).map((s) => headingKey(s.heading)).filter(Boolean));
    const pieceSections = splitSections(next).map((s) => headingKey(s.heading)).filter(Boolean);
    const overlap = pieceSections.filter((h) => existingSections.has(h)).length;
    if (pieceSections.length > 0 && overlap >= Math.max(2, Math.ceil(pieceSections.length * 0.6))) {
      return countNonEmptyLines(next) > countNonEmptyLines(existing) ? next : existing;
    }
  }

  // Trim a literal overlap where the model echoed the tail we fed it back.
  const maxOverlap = Math.min(600, existing.length, next.length);
  for (let len = maxOverlap; len >= 60; len -= 20) {
    if (next.startsWith(existing.slice(-len))) {
      next = next.slice(len);
      break;
    }
  }

  // Drop sections already present so the chapter doesn't list 「2.1 硬件要求」twice.
  const seen = new Set(splitSections(existing).map((s) => headingKey(s.heading)).filter(Boolean));
  const kept = splitSections(next).filter((s) => {
    const key = headingKey(s.heading);
    if (!key) return s.body.trim().length > 0;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const merged = kept.map((s) => [s.heading, s.body].filter(Boolean).join("\n")).join("\n\n").trim();
  if (!merged) return existing;
  return `${existing.trim()}\n\n${merged}`;
}

/**
 * Final structural pass: keep one copy of each chapter and of each section inside
 * it. Guards against duplication that slipped past per-turn merging (e.g. a
 * resumed draft that already contained a partial chapter).
 *
 * Exported so an already-generated document can be repaired without regenerating.
 */
export function dedupeManualDocument(text: string): string {
  const lines = text.split("\n");
  const chapters: { heading: string; body: string[] }[] = [];
  let cur: { heading: string; body: string[] } = { heading: "", body: [] };
  for (const line of lines) {
    const t = line.trim();
    if (/^#\s+/.test(t) && !/^#{2,}\s+/.test(t)) {
      chapters.push(cur);
      cur = { heading: t, body: [] };
    } else {
      cur.body.push(line);
    }
  }
  chapters.push(cur);

  const byTitle = new Map<string, { heading: string; body: string[] }>();
  const order: string[] = [];
  const preamble: string[] = [];
  for (const ch of chapters) {
    if (!ch.heading) {
      preamble.push(...ch.body);
      continue;
    }
    const key = headingKey(ch.heading);
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, ch);
      order.push(key);
      continue;
    }
    // Same chapter twice → keep the fuller version.
    const a = existing.body.filter((l) => l.trim()).length;
    const b = ch.body.filter((l) => l.trim()).length;
    if (b > a) byTitle.set(key, { heading: existing.heading, body: ch.body });
  }

  const out: string[] = [];
  const pre = preamble.join("\n").trim();
  if (pre) out.push(pre);
  for (const key of order) {
    const ch = byTitle.get(key)!;
    // Drop repeated ## sections within the chapter.
    const seen = new Set<string>();
    const sections = splitSections(ch.body.join("\n")).filter((s) => {
      const k = headingKey(s.heading);
      if (!k) return s.body.trim().length > 0;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const body = sections.map((s) => [s.heading, s.body].filter(Boolean).join("\n")).join("\n\n").trim();
    out.push([ch.heading, body].filter(Boolean).join("\n\n"));
  }
  return out.join("\n\n").trim();
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
- 项目描述：${repoDescription || "无"}

代码结构（节选）：
${fileTree.slice(0, 2500)}

代码摘要（节选）：
${codeSummary.slice(0, 3000)}`;

  const systemPrompt = `你是中国软件著作权「文档鉴别材料/操作说明书」撰写专家。
规则：
1. 只输出 Markdown 正文，不要输出目录，不要输出 JSON，不要用代码围栏包裹全文
2. 使用正式中文说明文风，面向操作、条理清晰；采用软著说明书的常规程式化表述即可，不需要追求独特文采
3. 一级标题必须使用给定的章节标题（以 # 开头），且整篇文档中该标题只出现一次
4. 可用 ## / ### 作为小节；图片用 [图章号-序号：描述] 占位
5. 本请求只写当前这一章，不要写其他章，不要重复已写章节；不要在同一章里把相同小节写两遍
6. 一次尽量写完整、详实（目标约 200–400 行文档），不要只写一两百字就结束
7. 功能模块、界面元素、错误码等具名内容必须与「软件信息」中的主要功能保持一致，全文前后统一；不要引入软件信息里没有提到的模块名，否则各章之间会互相矛盾

【严禁编造具体事实】以下内容只有在「软件信息」或代码结构中有依据时才可以写，否则必须改用概括表述：
- 编程语言与运行时：只能写「编程语言」一栏中列出的语言。不要因为提到 NFC、移动端等就自行添加 Kotlin/Java/Swift 等语言。
- 端口号、IP、数据库名、具体版本号（如 5432、8080、Node.js 18.20.0）：没有依据时写「按部署环境配置的服务端口」「参见运行支撑环境要求」这类表述。
- 安装脚本、可执行文件名、命令（如 setup.exe、install.sh、check_env.sh、npm run seed）：没有依据时描述操作步骤本身（「运行安装程序」「执行项目提供的启动命令」），不要虚构文件名。
- 第三方库名、协议名、硬件型号：同上，没有依据不要写。
这些编造出来的细节是软著审核退回的主要原因，宁可概括也不要具体错。
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

    // Feed forward what earlier chapters already established. Without this each
    // chapter invents its own module names and error codes, and the audit reads
    // the result as self-contradictory.
    const priorOutline = allText
      ? splitSections(allText)
          .map((s) => s.heading)
          .filter(Boolean)
          .slice(-60)
          .join("\n")
      : "";
    const continuityBlock = priorOutline
      ? `\n已写章节的小节标题（本章必须沿用其中的模块名与术语，不要另起名字，也不要重复这些小节）：\n${priorOutline}\n`
      : "";

    const userPrompt = `请只撰写以下这一章的完整 Markdown（不要目录、不要其它章）：

# ${chapter.title}

本章应覆盖：${chapter.outline}

${contextBlock}
${continuityBlock}
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
      const writtenSections = chapterText
        ? splitSections(chapterText).map((s) => s.heading).filter(Boolean).join("\n")
        : "";
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
                content: `本章目前约 ${countNonEmptyLines(chapterText)} 行，目标约 ${chapter.minLines} 行。\n\n本章已经写完的小节：\n${writtenSections || "（无小节标题）"}\n\n请紧接上文继续写本章**剩余**内容：不要重写「# ${chapter.title}」标题，不要重复上面列出的小节，不要开始下一章。如果本章内容已经写完整了，只回复「本章已完成」四个字。`,
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
        // Model signalled completion instead of padding — take it.
        if (chapterText && /^本章已完成[。.\s]*$/.test(piece.trim())) {
          onProgress?.(`${chapter.title} 已写完（模型确认）`);
          break;
        }
        // Merging rather than concatenating: models often restart the chapter from
        // its heading, which used to triple the same content into the document.
        chapterText = chapterText ? mergeContinuation(chapterText, piece, chapter.title) : piece;

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

    // A resumed draft may already hold a partial version of this chapter; replace
    // it instead of appending a second copy.
    if (chapterAlreadyPresent(allText, chapter.title)) {
      const stale = extractChapter(allText, chapter.title);
      if (stale) allText = allText.replace(stale, "").trim();
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

  // Final structural pass: one copy of each chapter, one copy of each section.
  const deduped = dedupeManualDocument(allText);
  const removed = countNonEmptyLines(allText) - countNonEmptyLines(deduped);
  if (removed > 0) {
    onProgress?.(`已清理重复章节/小节 ${removed} 行`);
  }

  return sanitizeSoftCopyrightText(deduped) + "\n";
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
