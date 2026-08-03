import { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/ai/require-session";
import { TestRequestSchema } from "@/lib/server/ai/request-schema";
import { runtimeConfigFromCredentials } from "@/lib/server/ai/runtime-config";
import { testModel } from "@/lib/server/ai/ai-service";
import { aiErrorResponse } from "@/lib/server/ai/http";
import { AIError, AIErrorCodes } from "@/lib/server/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await requireSession();

    const json = await request.json();
    const parsed = TestRequestSchema.safeParse(json);
    if (!parsed.success) {
      throw new AIError({
        code: AIErrorCodes.INVALID_REQUEST,
        message: "请求参数无效",
      });
    }

    const config = runtimeConfigFromCredentials(parsed.data);
    const result = await testModel(config);
    return Response.json(
      result,
      { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (err) {
    return aiErrorResponse(err, requestId);
  }
}