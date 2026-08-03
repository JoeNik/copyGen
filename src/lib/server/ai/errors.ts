/**
 * Server-only structured error types for AI proxy operations.
 *
 * Errors are classified into stable codes that both server handlers and the
 * client error-presentation layer understand. The client never receives raw
 * upstream bodies or stack traces.
 */

/* ── Error codes ────────────────────────────────────────────────────── */

export const AIErrorCodes = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INVALID_REQUEST: "INVALID_REQUEST",
  INVALID_BASE_URL: "INVALID_BASE_URL",
  PRIVATE_ADDRESS_BLOCKED: "PRIVATE_ADDRESS_BLOCKED",
  UPSTREAM_AUTH_FAILED: "UPSTREAM_AUTH_FAILED",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  MODEL_LIST_UNSUPPORTED: "MODEL_LIST_UNSUPPORTED",
  UPSTREAM_RATE_LIMITED: "UPSTREAM_RATE_LIMITED",
  UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT",
  UPSTREAM_UNREACHABLE: "UPSTREAM_UNREACHABLE",
  UPSTREAM_HTTP_ERROR: "UPSTREAM_HTTP_ERROR",
  INVALID_UPSTREAM_RESPONSE: "INVALID_UPSTREAM_RESPONSE",
} as const;

export type AIErrorCode = (typeof AIErrorCodes)[keyof typeof AIErrorCodes];

/* ── Error class ────────────────────────────────────────────────────── */

export interface AIErrorPayload {
  code: AIErrorCode;
  message: string;
  suggestion?: string;
  /** Upstream HTTP status when applicable. */ status?: number;
  /** Sanitised host (no path/query/credentials). */ host?: string;
  /** Correlatable request id provided by the handler. */ requestId?: string;
}

export class AIError extends Error {
  public readonly code: AIErrorCode;
  public readonly upstreamStatus?: number;
  public readonly host?: string;
  public readonly requestId?: string;

  constructor(payload: AIErrorPayload) {
    super(payload.message);
    this.name = "AIError";
    this.code = payload.code;
    this.upstreamStatus = payload.status;
    this.host = payload.host;
    this.requestId = payload.requestId;
  }

  /** Serialise to the stable API response shape (no stack, no keys). */
  toJSON(): AIErrorPayload {
    return {
      code: this.code,
      message: this.message,
      suggestion: this.suggestionText(),
      status: this.upstreamStatus,
      host: this.host,
      requestId: this.requestId,
    };
  }

  private suggestionText(): string | undefined {
    switch (this.code) {
      case AIErrorCodes.AUTH_REQUIRED:
        return "请先使用 GitHub 登录";
      case AIErrorCodes.INVALID_REQUEST:
        return "请检查请求参数";
      case AIErrorCodes.INVALID_BASE_URL:
        return "请检查 API 地址格式是否正确";
      case AIErrorCodes.PRIVATE_ADDRESS_BLOCKED:
        return "服务暂不支持局域网地址，请使用公网 API 地址";
      case AIErrorCodes.UPSTREAM_AUTH_FAILED:
        return "请检查 API Key 是否正确或是否已过期";
      case AIErrorCodes.MODEL_NOT_FOUND:
        return "请检查模型名称是否正确或当前接口是否支持该模型";
      case AIErrorCodes.MODEL_LIST_UNSUPPORTED:
        return "当前供应商不支持自动获取模型列表，您可以直接输入模型名称";
      case AIErrorCodes.UPSTREAM_RATE_LIMITED:
        return "供应商接口限流，请稍后重试";
      case AIErrorCodes.UPSTREAM_TIMEOUT:
        return "供应商接口超时，请稍后重试或检查 API 地址";
      case AIErrorCodes.UPSTREAM_UNREACHABLE:
        return "无法连接到供应商接口，请检查 API 地址、网络或代理设置";
      case AIErrorCodes.UPSTREAM_HTTP_ERROR:
        return "供应商接口返回错误，请稍后重试";
      case AIErrorCodes.INVALID_UPSTREAM_RESPONSE:
        return "供应商返回了无法解析的响应，请检查接口兼容性";
    }
  }
}

/* ── Response-body sanitisation ─────────────────────────────────────── */

const MAX_BODY_SNIPPET = 200;

/** Return at most MAX_BODY_SNIPPET chars, stripping non-ASCII control chars
 *  except newlines and tabs. Never returns binary data. */
export function sanitiseUpstreamBody(body: string): string {
  return body
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .slice(0, MAX_BODY_SNIPPET);
}

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Map an upstream HTTP status and optional error body to the best-fit code. */
export function classifyUpstreamStatus(
  status: number,
  errorBody?: string,
): { code: AIErrorCode; message: string } {
  if (status === 401 || status === 403) {
    return { code: AIErrorCodes.UPSTREAM_AUTH_FAILED, message: "供应商接口鉴权失败" };
  }
  if (status === 404) {
    const lower = (errorBody ?? "").toLowerCase();
    if (lower.includes("model")) {
      return { code: AIErrorCodes.MODEL_NOT_FOUND, message: "模型未找到或不存在" };
    }
    return { code: AIErrorCodes.UPSTREAM_HTTP_ERROR, message: `供应商返回 404` };
  }
  if (status === 429) {
    return { code: AIErrorCodes.UPSTREAM_RATE_LIMITED, message: "供应商请求过于频繁，触发限流" };
  }
  if (status >= 500) {
    return { code: AIErrorCodes.UPSTREAM_HTTP_ERROR, message: `供应商服务端错误 (${status})` };
  }
  return { code: AIErrorCodes.UPSTREAM_HTTP_ERROR, message: `供应商返回 HTTP ${status}` };
}