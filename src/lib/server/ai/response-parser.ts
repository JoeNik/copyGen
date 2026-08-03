import type { AICompletion, AIProtocol } from "@/lib/ai/contracts";
import { AIError, AIErrorCodes } from "./errors";

/* ── Single-payload extraction ──────────────────────────────────────── */

function extractFromPayload(
  data: Record<string, unknown>,
  protocol: AIProtocol,
): { text: string; finishReason: string } {
  if (protocol === "openai") {
    const choices = data?.choices as
      | Array<{
          message?: { content?: string };
          delta?: { content?: string };
          text?: string;
          finish_reason?: string | null;
        }>
      | undefined;
    const choice = choices?.[0];
    const text =
      choice?.delta?.content ?? choice?.message?.content ?? choice?.text ?? "";
    const fr = choice?.finish_reason;
    const finishReason = fr ? fr : choice?.delta ? "continue" : "stop";
    return { text, finishReason };
  }

  if (protocol === "claude") {
    const content = data?.content as
      | Array<{ type?: string; text?: string }>
      | undefined;
    if (Array.isArray(content) && content.length > 0) {
      const text = content
        .filter((c) => c.type === "text" || typeof c.text === "string")
        .map((c) => c.text ?? "")
        .join("");
      return { text, finishReason: (data?.stop_reason as string) || "end_turn" };
    }

    const type = data?.type as string | undefined;
    if (type === "content_block_delta") {
      const delta = data?.delta as { type?: string; text?: string } | undefined;
      return { text: delta?.text ?? "", finishReason: "continue" };
    }
    if (type === "message_delta") {
      const delta = data?.delta as { stop_reason?: string } | undefined;
      return { text: "", finishReason: delta?.stop_reason ?? "end_turn" };
    }
    if (type === "message_stop") {
      return { text: "", finishReason: "end_turn" };
    }
    return { text: "", finishReason: "continue" };
  }

  // Gemini
  const candidates = data?.candidates as
    | Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
    | undefined;
  const cand = candidates?.[0];
  const text =
    cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text, finishReason: cand?.finishReason ?? "STOP" };
}

/* ── Full response parser ───────────────────────────────────────────── */

/**
 * Parse an AI API response that may be:
 * - plain JSON object
 * - SSE stream (`data: {...}` lines with optional `: heartbeat` comments)
 * - NDJSON (one JSON object per line)
 *
 * Throws `AIError(INVALID_UPSTREAM_RESPONSE)` when the body is empty or
 * entirely invalid.  Does NOT require a non-2xx response — callers should
 * check the HTTP status first.
 */
export function parseAIResponse(
  rawBody: string,
  protocol: AIProtocol,
): AICompletion {
  const trimmed = rawBody.trim();

  if (!trimmed) {
    throw new AIError({
      code: AIErrorCodes.INVALID_UPSTREAM_RESPONSE,
      message: "上游返回了空响应体",
    });
  }

  // Fast path: pure JSON object/array
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      if (data.error && typeof data.error === "object") {
        const err = data.error as { message?: string };
        throw new AIError({
          code: AIErrorCodes.UPSTREAM_HTTP_ERROR,
          message: err.message ?? "上游返回了错误",
        });
      }
      return extractFromPayload(data, protocol);
    } catch (e) {
      if (e instanceof AIError) throw e;
      // fall through to line-based parsing
    }
  }

  // SSE / NDJSON / heartbeat-polluted body
  let text = "";
  let finishReason = "stop";
  const lines = rawBody.split(/\r?\n/);
  let parsedAny = false;

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;

    // SSE comment / heartbeat
    if (s.startsWith(":")) continue;
    // SSE meta-lines
    if (s.startsWith("event:")) continue;
    if (s.startsWith("id:")) continue;
    if (s.startsWith("retry:")) continue;

    let payload: string = s;
    if (s.startsWith("data:")) {
      payload = s.slice(5).trim();
    }

    if (!payload || payload === "[DONE]") {
      if (payload === "[DONE]") {
        if (finishReason === "continue") finishReason = "stop";
        parsedAny = true;
      }
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
        throw new AIError({
          code: AIErrorCodes.UPSTREAM_HTTP_ERROR,
          message: err.message ?? "上游响应中包含错误",
        });
      }
      const part = extractFromPayload(data, protocol);
      if (part.text) text += part.text;
      if (part.finishReason && part.finishReason !== "continue") {
        finishReason = part.finishReason;
      }
      parsedAny = true;
    } catch (e) {
      if (e instanceof AIError) throw e;
      // skip malformed chunk
    }
  }

  if (!parsedAny || (!text && finishReason === "stop")) {
    // Last resort: try to find a JSON object embedded in the text
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const data = JSON.parse(match[0]) as Record<string, unknown>;
        if (data.error && typeof data.error === "object") {
          const err = data.error as { message?: string };
          throw new AIError({
            code: AIErrorCodes.UPSTREAM_HTTP_ERROR,
            message: err.message ?? "上游返回了错误",
          });
        }
        return extractFromPayload(data, protocol);
      } catch (e) {
        if (e instanceof AIError) throw e;
      }
    }

    throw new AIError({
      code: AIErrorCodes.INVALID_UPSTREAM_RESPONSE,
      message: "无法从上游响应中解析出有效内容",
    });
  }

  return { text, finishReason };
}