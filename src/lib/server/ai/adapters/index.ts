import type { ProviderRuntimeConfig, GenerateOptions, ProviderAdapter } from "./types";
import type { AIMessage, AICompletion, AIModelOption } from "@/lib/ai/contracts";
import type { AIProtocol } from "@/lib/ai/contracts";

/* ── Adapter registry ──────────────────────────────────────────────── */

// Adapters are wired in Task 4 but only the URL builders + model-list
// normalisation exist so far. The full adapter (generate/stream) is provided
// by ai-service.ts directly via buildGenerationRequest / streamCompletion.
// This module exposes the type-safe adapter selector for callers that want
// protocol-aware behaviour.

export function getProviderAdapter(protocol: AIProtocol): ProviderAdapter {
  switch (protocol) {
    case "openai":
      return openaiAdapter;
    case "claude":
      return claudeAdapter;
    case "gemini":
      return geminiAdapter;
    default: {
      const exhaustive: never = protocol;
      throw new Error(`不支持的协议: ${String(exhaustive)}`);
    }
  }
}

const noopAdapter: ProviderAdapter = {
  listModels: async () => [],
  generate: async () => ({ text: "", finishReason: "stop" }),
  stream: async () => new ReadableStream({ start(c) { c.close(); } }),
};

const openaiAdapter = noopAdapter;
const claudeAdapter = noopAdapter;
const geminiAdapter = noopAdapter;

/* ── Convenience wrappers ──────────────────────────────────────────── */

export async function listModels(
  config: ProviderRuntimeConfig,
  options?: { signal?: AbortSignal },
): Promise<AIModelOption[]> {
  const adapter = getProviderAdapter(config.protocol);
  return adapter.listModels(config, options);
}

export async function generate(
  config: ProviderRuntimeConfig,
  messages: AIMessage[],
  options: GenerateOptions,
): Promise<AICompletion> {
  const adapter = getProviderAdapter(config.protocol);
  return adapter.generate(config, messages, options);
}

export async function stream(
  config: ProviderRuntimeConfig,
  messages: AIMessage[],
  options: GenerateOptions,
): Promise<ReadableStream<Uint8Array>> {
  const adapter = getProviderAdapter(config.protocol);
  return adapter.stream(config, messages, options);
}