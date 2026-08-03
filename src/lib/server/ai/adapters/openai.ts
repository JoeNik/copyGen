export interface NormalisedUrls {
  generation: string;
  models: string;
}

/**
 * Build OpenAI-compatible generation and model-list URLs from a flexible base.
 */
export function buildOpenAIUrl(baseUrl: string): NormalisedUrls {
  const b = baseUrl.replace(/\/+$/, "");

  // Already a full generation endpoint
  if (b.endsWith("/chat/completions")) {
    const base = b.slice(0, -"/chat/completions".length);
    return { generation: b, models: `${base}/models` };
  }

  // Already versioned path, e.g. https://open.bigmodel.cn/api/paas/v4
  const versionMatch = b.match(/\/v\d+$/i);
  if (versionMatch) {
    return {
      generation: `${b}/chat/completions`,
      models: `${b}/models`,
    };
  }

  // Default: append /v1/
  return {
    generation: `${b}/v1/chat/completions`,
    models: `${b}/v1/models`,
  };
}