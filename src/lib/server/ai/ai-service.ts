import type { AICompletion, AIModelOption, AIProtocol } from "@/lib/ai/contracts";
import { AIError, AIErrorCodes, classifyUpstreamStatus, sanitiseUpstreamBody } from "./errors";
import { parseAIResponse } from "./response-parser";
import { safeFetch } from "./safe-fetch";
import { safeHost } from "./http";
import { buildOpenAIUrl } from "./adapters/openai";
import { buildClaudeUrl } from "./adapters/claude";
import { buildGeminiUrl, normaliseGeminiModelList } from "./adapters/gemini";
import type { ProviderRuntimeConfig } from "./adapters/types";

/* ── Config helpers ────────────────────────────────────────────────── */

const DEFAULT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 15_000;
const MAX_MODELS_RETURNED = 200;

/* ── Headers ────────────────────────────────────────────────────────── */

function generationHeaders(protocol: AIProtocol, apiKey: string, stream: boolean): Record<string, string> {
  const base: Record<string, string> = { "Content-Type": "application/json" };
  if (protocol === "openai") {
    base["Authorization"] = `Bearer ${apiKey}`;
  } else if (protocol === "claude") {
    base["x-api-key"] = apiKey;
    base["anthropic-version"] = "2023-06-01";
  }
  // gemini sends key in query string, see buildGeminiRequest
  void stream;
  return base;
}

/* ── Request builders ───────────────────────────────────────────────── */

function buildGenerationRequest(
  config: ProviderRuntimeConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
  stream: boolean,
): { url: string; headers: Record<string, string>; body: string } {
  if (config.protocol === "openai") {
    const { generation } = buildOpenAIUrl(config.baseUrl);
    return {
      url: generation,
      headers: generationHeaders("openai", config.apiKey, stream),
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        stream,
        messages,
      }),
    };
  }
  if (config.protocol === "claude") {
    const { generation } = buildClaudeUrl(config.baseUrl);
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system");
    return {
      url: generation,
      headers: generationHeaders("claude", config.apiKey, stream),
      body: JSON.stringify({
        model: config.model,
        max_tokens: maxTokens,
        stream,
        ...(system ? { system } : {}),
        messages: rest,
      }),
    };
  }
  // gemini
  const { generation } = buildGeminiUrl(config.baseUrl, config.model, stream);
  const systemInstruction = messages.find((m) => m.role === "system")?.content;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  // Gemini uses key in query — attach it
  const urlWithKey = `${generation}${generation.includes("?") ? "&" : "?"}key=${encodeURIComponent(config.apiKey)}`;
  return {
    url: urlWithKey,
    headers: generationHeaders("gemini", config.apiKey, stream),
    body: JSON.stringify({
      contents,
      ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  };
}

function buildListModelsRequest(
  config: ProviderRuntimeConfig,
): { url: string; headers: Record<string, string> } {
  if (config.protocol === "openai") {
    const { models } = buildOpenAIUrl(config.baseUrl);
    return { url: models, headers: generationHeaders("openai", config.apiKey, false) };
  }
  if (config.protocol === "claude") {
    const { models } = buildClaudeUrl(config.baseUrl);
    return { url: models, headers: generationHeaders("claude", config.apiKey, false) };
  }
  // gemini
  const { models } = buildGeminiUrl(config.baseUrl, config.model, false);
  const urlWithKey = `${models}?key=${encodeURIComponent(config.apiKey)}`;
  return { url: urlWithKey, headers: generationHeaders("gemini", config.apiKey, false) };
}

/* ── Error mapping from upstream fetch failures ────────────────────── */

async function classifyFetchError(err: unknown, baseUrl: string): Promise<AIError> {
  const host = safeHost(baseUrl);
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("timeout") || err.name === "AbortError") {
      return new AIError({
        code: AIErrorCodes.UPSTREAM_TIMEOUT,
        message: "上游接口超时",
        host,
      });
    }
    if (msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("eai_again") || msg.includes("fetch failed")) {
      return new AIError({
        code: AIErrorCodes.UPSTREAM_UNREACHABLE,
        message: "无法连接到上游接口",
        host,
      });
    }
  }
  return new AIError({
    code: AIErrorCodes.UPSTREAM_HTTP_ERROR,
    message: err instanceof Error ? err.message : String(err),
    host,
  });
}

async function readBodyAndClassify(
  res: { status: number; ok: boolean; body?: unknown },
  text: string,
  baseUrl: string,
): Promise<AIError> {
  const host = safeHost(baseUrl);
  const { code, message } = classifyUpstreamStatus(res.status, text);
  return new AIError({
    code,
    message: `${message}${text ? `：${sanitiseUpstreamBody(text)}` : ""}`,
    status: res.status,
    host,
  });
}

/* ── Public API ─────────────────────────────────────────────────────── */

/** Non-streaming generation. */
export async function generateCompletion(
  config: ProviderRuntimeConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<AICompletion> {
  const { url, headers, body } = buildGenerationRequest(config, messages, maxTokens, false);

  let res;
  try {
    res = await safeFetch(url, { method: "POST", headers, body, timeoutMs });
  } catch (err) {
    throw await classifyFetchError(err, config.baseUrl);
  }

  const response = res as unknown as { status: number; ok: boolean };
  if (!response.ok) {
    const text = await readText(res);
    throw await readBodyAndClassify(response, text, config.baseUrl);
  }

  const text = await readText(res);
  try {
    return parseAIResponse(text, config.protocol);
  } catch (err) {
    if (err instanceof AIError) throw err;
    throw new AIError({
      code: AIErrorCodes.INVALID_UPSTREAM_RESPONSE,
      message: err instanceof Error ? err.message : String(err),
      host: safeHost(config.baseUrl),
    });
  }
}

/** Streaming generation — returns a ReadableStream of normalised SSE bytes. */
export async function streamCompletion(
  config: ProviderRuntimeConfig,
  messages: { role: string; content: string }[],
  maxTokens: number,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ReadableStream<Uint8Array>> {
  const { url, headers, body } = buildGenerationRequest(config, messages, maxTokens, true);

  let res;
  try {
    res = await safeFetch(url, { method: "POST", headers, body, timeoutMs });
  } catch (err) {
    throw await classifyFetchError(err, config.baseUrl);
  }

  const response = res as unknown as { status: number; ok: boolean; body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null };
  if (!response.ok) {
    const text = await readText(res);
    throw await readBodyAndClassify(response, text, config.baseUrl);
  }

  const upstream = toWebStream(response.body);
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          let nlIdx: number;
          while ((nlIdx = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nlIdx);
            buffer = buffer.slice(nlIdx + 1);
            const parsed = parseStreamLine(line, config.protocol);
            for (const evt of parsed) {
              controller.enqueue(encoder.encode(formatSSE(evt)));
            }
          }
        }
        // flush remaining
        if (buffer.trim()) {
          const parsed = parseStreamLine(buffer, config.protocol);
          for (const evt of parsed) {
            controller.enqueue(encoder.encode(formatSSE(evt)));
          }
        }
        controller.enqueue(encoder.encode(formatSSE({ event: "done", data: { finishReason: "stop" } })));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(
          encoder.encode(
            formatSSE({ event: "error", data: { code: AIErrorCodes.UPSTREAM_HTTP_ERROR, message } }),
          ),
        );
        controller.close();
      }
    },
  });
}

function parseStreamLine(
  line: string,
  protocol: AIProtocol,
): Array<{ event: "delta" | "done"; data: Record<string, unknown> }> {
  const s = line.trim();
  if (!s || s.startsWith(":") || s.startsWith("event:") || s.startsWith("id:") || s.startsWith("retry:")) {
    return [];
  }
  let payload = s;
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (!payload || payload === "[DONE]") {
    return [{ event: "done", data: { finishReason: "stop" } }];
  }
  if (!(payload.startsWith("{") || payload.startsWith("["))) return [];
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    const part = extractDelta(data, protocol);
    if (part.text) {
      return [{ event: "delta", data: { text: part.text } }];
    }
    if (part.finishReason && part.finishReason !== "continue") {
      return [{ event: "done", data: { finishReason: part.finishReason } }];
    }
    return [];
  } catch {
    return [];
  }
}

function extractDelta(data: Record<string, unknown>, protocol: AIProtocol): { text: string; finishReason: string } {
  if (protocol === "openai") {
    const choices = data?.choices as Array<{ delta?: { content?: string }; finish_reason?: string | null }> | undefined;
    const choice = choices?.[0];
    return {
      text: choice?.delta?.content ?? "",
      finishReason: choice?.finish_reason ?? "continue",
    };
  }
  if (protocol === "claude") {
    const type = data?.type as string | undefined;
    if (type === "content_block_delta") {
      const delta = data?.delta as { text?: string } | undefined;
      return { text: delta?.text ?? "", finishReason: "continue" };
    }
    if (type === "message_delta") {
      const delta = data?.delta as { stop_reason?: string } | undefined;
      return { text: "", finishReason: delta?.stop_reason ?? "end_turn" };
    }
    return { text: "", finishReason: "continue" };
  }
  // gemini
  const candidates = data?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }> | undefined;
  const cand = candidates?.[0];
  return {
    text: cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
    finishReason: cand?.finishReason ?? "continue",
  };
}

function formatSSE(evt: { event: string; data: Record<string, unknown> }): string {
  return `event: ${evt.event}\ndata: ${JSON.stringify(evt.data)}\n\n`;
}

/** Fetch the provider's model list, normalise, dedupe, sort and cap. */
export async function listProviderModels(
  config: ProviderRuntimeConfig,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<AIModelOption[]> {
  const { url, headers } = buildListModelsRequest(config);

  let res;
  try {
    res = await safeFetch(url, { method: "GET", headers, timeoutMs });
  } catch (err) {
    throw await classifyFetchError(err, config.baseUrl);
  }

  const response = res as unknown as { status: number; ok: boolean };
  if (!response.ok) {
    const text = await readText(res);
    // Some providers (and Anthropic historically) return 404/405 for the models
    // endpoint — surface as MODEL_LIST_UNSUPPORTED so the UI can fall back to manual input
    if (response.status === 404 || response.status === 405) {
      throw new AIError({
        code: AIErrorCodes.MODEL_LIST_UNSUPPORTED,
        message: "该供应商不支持自动获取模型列表",
        status: response.status,
        host: safeHost(config.baseUrl),
      });
    }
    throw await readBodyAndClassify(response, text, config.baseUrl);
  }

  const text = await readText(res);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AIError({
      code: AIErrorCodes.MODEL_LIST_UNSUPPORTED,
      message: "无法解析该供应商的模型列表响应",
      host: safeHost(config.baseUrl),
    });
  }

  const models = extractModels(parsed, config.protocol);

  // Dedupe, sort, cap
  const seen = new Set<string>();
  const result: AIModelOption[] = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    result.push(m);
    if (result.length >= MAX_MODELS_RETURNED) break;
  }
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}

function extractModels(parsed: Record<string, unknown>, protocol: AIProtocol): AIModelOption[] {
  if (protocol === "gemini") {
    const raw = (parsed.models ?? []) as Array<{ name: string; supportedGenerationMethods?: string[] }>;
    return normaliseGeminiModelList(raw);
  }
  // OpenAI-compatible and Claude both use { data: [{ id, ... }] }
  const data = (parsed.data ?? []) as Array<{ id: string; name?: string; description?: string }>;
  return data
    .filter((m) => typeof m.id === "string" && m.id)
    .map((m) => ({
      id: m.id,
      displayName: m.name,
      description: m.description,
    }));
}

/** Run a minimal real generation test against the given model. */
export async function testModel(
  config: ProviderRuntimeConfig,
  timeoutMs = LIST_TIMEOUT_MS,
): Promise<{ ok: true; provider: string; model: string; latencyMs: number; output: string; warning?: string }> {
  const start = Date.now();
  const completion = await generateCompletion(
    config,
    [{ role: "user", content: "仅回复 OK" }],
    16,
    timeoutMs,
  );
  const latencyMs = Date.now() - start;

  // Check if base URL is HTTP (insecure)
  let warning: string | undefined;
  try {
    if (new URL(config.baseUrl).protocol === "http:") {
      warning = "当前使用 HTTP 明文传输 API Key，建议改用 HTTPS";
    }
  } catch {
    // ignore
  }

  return {
    ok: true,
    provider: config.protocol,
    model: config.model,
    latencyMs,
    output: completion.text.slice(0, 200),
    warning,
  };
}

/* ── Helpers ───────────────────────────────────────────────────────── */

async function readText(res: unknown): Promise<string> {
  // undici response has a .body text reading method
  const r = res as { text?: () => Promise<string>; body?: { text?: () => Promise<string> } | ReadableStream<Uint8Array> };
  if (r && typeof r.text === "function") return r.text();
  // Fall back to streaming the body
  const stream = toWebStream((res as { body?: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null }).body);
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function toWebStream(body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null | undefined): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) return body;
  if (!body) return new ReadableStream({ start(c) { c.close(); } });
  // Node stream → web stream
  const nodeStream = body as NodeJS.ReadableStream & { [Symbol.asyncIterator]?: () => AsyncIterableIterator<unknown> };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of nodeStream as unknown as AsyncIterable<Buffer>) {
          controller.enqueue(new Uint8Array(chunk as Uint8Array));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}