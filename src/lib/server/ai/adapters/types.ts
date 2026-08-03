import type { AIProtocol, AIMessage, AICompletion, AIModelOption } from "@/lib/ai/contracts";

/** Resolved provider configuration ready for outbound use. */
export interface ProviderRuntimeConfig {
  protocol: AIProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface GenerateOptions {
  maxTokens: number;
}

export interface ListModelsOptions {
  /** Timeout in ms — defaults to 15_000. */
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  listModels(
    config: ProviderRuntimeConfig,
    options?: ListModelsOptions,
  ): Promise<AIModelOption[]>;

  generate(
    config: ProviderRuntimeConfig,
    messages: AIMessage[],
    options: GenerateOptions,
  ): Promise<AICompletion>;

  stream(
    config: ProviderRuntimeConfig,
    messages: AIMessage[],
    options: GenerateOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}