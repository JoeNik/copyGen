import type { NormalisedUrls } from "./openai";

export function buildClaudeUrl(baseUrl: string): NormalisedUrls {
  const b = baseUrl.replace(/\/+$/, "");

  // Already a generation endpoint
  if (b.endsWith("/messages")) {
    return { generation: b, models: `${b}/models` };
  }

  // Already versioned
  if (/\/v\d+$/i.test(b)) {
    return {
      generation: `${b}/messages`,
      models: `${b}/models`,
    };
  }

  return {
    generation: `${b}/v1/messages`,
    models: `${b}/v1/models`,
  };
}