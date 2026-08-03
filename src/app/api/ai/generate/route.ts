import { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/ai/require-session";
import { GenerateRequestSchema } from "@/lib/server/ai/request-schema";
import { runtimeConfigFromCredentials } from "@/lib/server/ai/runtime-config";
import { generateCompletion } from "@/lib/server/ai/ai-service";
import { aiErrorResponse } from "@/lib/server/ai/http";
import { AIError, AIErrorCodes } from "@/lib/server/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_MAX_TOKENS = 200;
const MAX_MAX_TOKENS = 8192;

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await requireSession();

    const json = await request.json();
    const parsed = GenerateRequestSchema.safeParse(json);
    if (!parsed.success) {
      throw new AIError({
        code: AIErrorCodes.INVALID_REQUEST,
        message: "请求参数无效",
      });
    }

    const { messages, maxTokens, ...creds } = parsed.data;
    const config = runtimeConfigFromCredentials(creds);
    const tokenBudget = Math.min(maxTokens ?? DEFAULT_MAX_TOKENS, MAX_MAX_TOKENS);

    const completion = await generateCompletion(config, messages, tokenBudget);
    return Response.json(
      completion,
      { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (err) {
    return aiErrorResponse(err, requestId);
  }
}