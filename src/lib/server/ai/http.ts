import { NextResponse } from "next/server";
import { AIError, AIErrorCodes, type AIErrorCode } from "./errors";

/** Build a stable error JSON response with no-store caching. */
export function aiErrorResponse(err: unknown, requestId: string): NextResponse {
  const payload = toAIErrorPayload(err, requestId);
  return NextResponse.json(
    { error: payload },
    {
      status: httpStatusFor(payload.code),
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    },
  );
}

function toAIErrorPayload(err: unknown, requestId: string) {
  if (err instanceof AIError) {
    return { ...err.toJSON(), requestId };
  }

  // OutboundPolicyError carries a code string
  const maybePolicy = err as { code?: string; message?: string };
  if (maybePolicy.code) {
    return {
      code: maybePolicy.code as AIErrorCode,
      message: maybePolicy.message ?? "出站请求被策略拦截",
      requestId,
    };
  }

  return {
    code: AIErrorCodes.UPSTREAM_HTTP_ERROR,
    message: err instanceof Error ? err.message : String(err),
    requestId,
  };
}

export function httpStatusFor(code: AIErrorCode): number {
  switch (code) {
    case AIErrorCodes.AUTH_REQUIRED:
      return 401;
    case AIErrorCodes.INVALID_REQUEST:
    case AIErrorCodes.INVALID_BASE_URL:
      return 400;
    case AIErrorCodes.PRIVATE_ADDRESS_BLOCKED:
      return 403;
    default:
      return 502;
  }
}

/** Extract hostname from a base URL for safe error messages (no path/query). */
export function safeHost(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).host;
  } catch {
    return undefined;
  }
}