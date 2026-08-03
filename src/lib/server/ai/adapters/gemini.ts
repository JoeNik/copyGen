import type { AIModelOption } from "@/lib/ai/contracts";

export interface GeminiModelEntry {
  name: string;
  supportedGenerationMethods?: string[];
}

/**
 * Build Gemini generation and model-list URLs.
 * Doesn't put the API key in the URL per se — key is supplied via query param
 * by the caller in the actual fetch, matching the SDK convention.
 */
export function buildGeminiUrl(
  baseUrl: string,
  model: string,
  stream = false,
): { generation: string; models: string } {
  const b = baseUrl.replace(/\/+$/, "");
  const versioned = /\/v\d+[a-z]*$/i.test(b) ? b : `${b}/v1beta`;
  const safeModel = encodeURIComponent(model);
  const method = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return {
    generation: `${versioned}/models/${safeModel}:${method}`,
    models: `${versioned}/models`,
  };
}

/**
 * Normalise the Gemini model-list response.
 * - Filters to entries that support `generateContent`.
 * - Strips the `models/` prefix from `name`.
 * - Returns deduplicated, sorted options.
 */
export function normaliseGeminiModelList(
  raw: GeminiModelEntry[],
): AIModelOption[] {
  const seen = new Set<string>();
  const result: AIModelOption[] = [];

  for (const entry of raw) {
    const methods = entry.supportedGenerationMethods ?? [];
    if (!methods.includes("generateContent")) continue;

    const id = entry.name.replace(/^models\//, "");
    if (seen.has(id)) continue;
    seen.add(id);

    result.push({
      id,
      displayName: id,
      capabilities: methods,
    });
  }

  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}