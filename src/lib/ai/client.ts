import type { AICompletion, AIMessage } from "@/lib/ai/contracts";
import { getActiveProvider } from "@/lib/storage";

/** Stable error thrown by the same-origin AI client. */
export class AIClientError extends Error {
  public readonly code: string;
  public readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "AIClientError";
    this.code = code;
    this.status = status;
  }
}

interface ProviderCredentials {
  protocol: "openai" | "claude" | "gemini";
  baseUrl: string;
  model: string;
  apiKey: string;
}

function readCredentials(): ProviderCredentials {
  const active = getActiveProvider();
  if (!active || !active.apiKey) {
    throw new AIClientError(
      "PROVIDER_NOT_CONFIGURED",
      "请先在设置中配置并启用一个 AI 提供商",
    );
  }
  return {
    protocol: active.protocol,
    baseUrl: active.baseUrl,
    model: active.model,
    apiKey: active.apiKey,
  };
}

interface AIErrorResponse {
  error: {
    code: string;
    message: string;
    suggestion?: string;
    status?: number;
    host?: string;
    requestId?: string;
  };
}

function toAIClientError(res: Response, body: AIErrorResponse | unknown): AIClientError {
  const err = (body as AIErrorResponse)?.error;
  if (err) {
    return new AIClientError(err.code, err.message ?? "AI 接口错误", res.status);
  }
  if (res.status === 401) {
    return new AIClientError("AUTH_REQUIRED", "登录已失效，请重新使用 GitHub 登录", 401);
  }
  return new AIClientError("UPSTREAM_HTTP_ERROR", `AI 接口错误 (${res.status})`, res.status);
}

/** Non-streaming generation via the authenticated same-origin endpoint. */
export async function generateAI(
  messages: AIMessage[],
  maxTokens: number,
): Promise<AICompletion> {
  const creds = readCredentials();
  const res = await fetch("/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ ...creds, messages, maxTokens }),
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw toAIClientError(res, body);
  }

  return (await res.json()) as AICompletion;
}

/** Streaming generation via the authenticated same-origin endpoint.
 *  Returns the concatenated text and final finish reason. */
export async function streamAI(
  messages: AIMessage[],
  maxTokens: number,
): Promise<AICompletion> {
  const creds = readCredentials();
  const res = await fetch("/api/ai/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    cache: "no-store",
    body: JSON.stringify({ ...creds, messages, maxTokens }),
  });

  if (!res.ok || !res.body) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw toAIClientError(res, body);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let finishReason = "stop";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evt = parseSSEBlock(block);
      if (!evt) continue;
      if (evt.event === "delta" && typeof evt.data.text === "string") {
        text += evt.data.text;
      } else if (evt.event === "done" && typeof evt.data.finishReason === "string") {
        finishReason = evt.data.finishReason;
      } else if (evt.event === "error") {
        const code = typeof evt.data.code === "string" ? evt.data.code : "UPSTREAM_HTTP_ERROR";
        throw new AIClientError(
          code,
          typeof evt.data.message === "string" ? evt.data.message : "流式生成失败",
        );
      }
    }
  }

  return { text, finishReason };
}

interface ParsedSSE {
  event: "delta" | "done" | "error";
  data: Record<string, unknown>;
}

function parseSSEBlock(block: string): ParsedSSE | null {
  let event = "delta" as ParsedSSE["event"];
  let dataStr = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim() as ParsedSSE["event"];
    } else if (line.startsWith("data:")) {
      dataStr += line.slice(5).trim();
    }
  }
  if (!dataStr) return null;
  try {
    const data = JSON.parse(dataStr) as Record<string, unknown>;
    return { event, data };
  } catch {
    return null;
  }
}