import type { AIProtocol } from "@/lib/ai/contracts";
import type { ProviderRuntimeConfig } from "@/lib/server/ai/adapters/types";

interface CredentialsInput {
  protocol: AIProtocol;
  baseUrl: string;
  model?: string;
  apiKey: string;
}

/** Build a ProviderRuntimeConfig from validated client-supplied credentials. */
export function runtimeConfigFromCredentials(input: CredentialsInput): ProviderRuntimeConfig {
  return {
    protocol: input.protocol,
    baseUrl: input.baseUrl,
    model: input.model ?? "",
    apiKey: input.apiKey,
  };
}