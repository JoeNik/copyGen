import { z } from "zod";

/** Schema for provider credentials sent from the browser (never persisted server-side). */
export const ProviderCredentialsSchema = z.object({
  protocol: z.enum(["openai", "claude", "gemini"]),
  baseUrl: z
    .string()
    .min(1)
    .max(512)
    .transform((s) => s.replace(/\/+$/, "")),
  model: z.string().max(256).optional(),
  apiKey: z.string().min(1).max(4096),
});

export type ProviderCredentials = z.infer<typeof ProviderCredentialsSchema>;

/** Schema for generation requests. */
export const GenerateRequestSchema = z.object({
  protocol: z.enum(["openai", "claude", "gemini"]),
  baseUrl: z.string().min(1).max(512).transform((s) => s.replace(/\/+$/, "")),
  model: z.string().min(1).max(256),
  apiKey: z.string().min(1).max(4096),
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1).max(80_000),
      }),
    )
    .min(1)
    .max(200),
  maxTokens: z.number().int().min(1).max(32_768).optional(),
});

export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

/** Schema for the model test endpoint — hardcoded prompt, user cannot submit one. */
export const TestRequestSchema = z.object({
  protocol: z.enum(["openai", "claude", "gemini"]),
  baseUrl: z.string().min(1).max(512).transform((s) => s.replace(/\/+$/, "")),
  model: z.string().min(1).max(256),
  apiKey: z.string().min(1).max(4096),
});

export type TestRequest = z.infer<typeof TestRequestSchema>;