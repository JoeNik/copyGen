import { NextRequest } from "next/server";
import { requireSession } from "@/lib/server/ai/require-session";
import { ProviderCredentialsSchema } from "@/lib/server/ai/request-schema";
import { runtimeConfigFromCredentials } from "@/lib/server/ai/runtime-config";
import { listProviderModels } from "@/lib/server/ai/ai-service";
import { aiErrorResponse } from "@/lib/server/ai/http";
import { AIError, AIErrorCodes } from "@/lib/server/ai/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = crypto.randomUUID();
  try {
    await requireSession();

    const json = await request.json();
    const parsed = ProviderCredentialsSchema.safeParse(json);
    if (!parsed.success) {
      throw new AIError({
        code: AIErrorCodes.INVALID_REQUEST,
        message: "请求参数无效",
      });
    }

    const config = runtimeConfigFromCredentials(parsed.data);
    const models = await listProviderModels(config);
    return Response.json(
      { models },
      { headers: { "Cache-Control": "no-store", "X-Request-Id": requestId } },
    );
  } catch (err) {
    return aiErrorResponse(err, requestId);
  }
}