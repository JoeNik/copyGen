import { describe, expect, it } from "vitest";
import { buildOpenAIUrl } from "./openai";

describe("buildOpenAIUrl", () => {
  it("root base → generation path", () => {
    const result = buildOpenAIUrl("https://api.openai.com");
    expect(result.generation).toBe("https://api.openai.com/v1/chat/completions");
    expect(result.models).toBe("https://api.openai.com/v1/models");
  });

  it("base ending with /v1 → no duplicate version", () => {
    const result = buildOpenAIUrl("https://api.openai.com/v1");
    expect(result.generation).toBe("https://api.openai.com/v1/chat/completions");
    expect(result.models).toBe("https://api.openai.com/v1/models");
  });

  it("base ending with /v4 → appends chat/completions and /v4/models", () => {
    const result = buildOpenAIUrl("https://open.bigmodel.cn/api/paas/v4");
    expect(result.generation).toBe("https://open.bigmodel.cn/api/paas/v4/chat/completions");
    expect(result.models).toBe("https://open.bigmodel.cn/api/paas/v4/models");
  });

  it("base already ending with /chat/completions → generation stays, models derived", () => {
    const result = buildOpenAIUrl("https://api.example.com/v1/chat/completions");
    expect(result.generation).toBe("https://api.example.com/v1/chat/completions");
    expect(result.models).toBe("https://api.example.com/v1/models");
  });

  it("strips trailing slash", () => {
    const result = buildOpenAIUrl("https://api.openai.com/");
    expect(result.generation).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("returns generation and model request headers with Bearer", () => {
    const headers = openAIHeaders("sk-test");
    expect(headers).toHaveProperty("Authorization", "Bearer sk-test");
    expect(headers).toHaveProperty("Content-Type", "application/json");
  });
});

function openAIHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

import { buildClaudeUrl } from "./claude";

describe("buildClaudeUrl", () => {
  it("root base → /v1/messages and /v1/models", () => {
    const r = buildClaudeUrl("https://api.anthropic.com");
    expect(r.generation).toBe("https://api.anthropic.com/v1/messages");
    expect(r.models).toBe("https://api.anthropic.com/v1/models");
  });

  it("base ending with /v1 → no duplicate", () => {
    const r = buildClaudeUrl("https://api.anthropic.com/v1");
    expect(r.generation).toBe("https://api.anthropic.com/v1/messages");
    expect(r.models).toBe("https://api.anthropic.com/v1/models");
  });

  it("base ending with /messages → stays for generation", () => {
    const r = buildClaudeUrl("https://api.anthropic.com/v1/messages");
    expect(r.generation).toBe("https://api.anthropic.com/v1/messages");
    expect(r.models).toBe("https://api.anthropic.com/v1/messages/models");
  });

  it("returns Claude headers without browser-only access header", () => {
    const headers = claudeHeaders("sk-ant-test");
    expect(headers).toHaveProperty("x-api-key", "sk-ant-test");
    expect(headers).toHaveProperty("anthropic-version", "2023-06-01");
    expect(headers).not.toHaveProperty("anthropic-dangerous-direct-browser-access");
  });
});

function claudeHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
}

import { buildGeminiUrl } from "./gemini";

describe("buildGeminiUrl", () => {
  it("root base → /v1beta with model and generateContent", () => {
    const r = buildGeminiUrl("https://generativelanguage.googleapis.com", "gemini-2.0-flash");
    expect(r.generation).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
    );
    expect(r.models).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("base already ending with /v1beta → no duplicate", () => {
    const r = buildGeminiUrl("https://generativelanguage.googleapis.com/v1beta", "gemini-pro");
    expect(r.generation).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
    );
    expect(r.models).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });

  it("streaming variant appends ?alt=sse", () => {
    const r = buildGeminiUrl(
      "https://generativelanguage.googleapis.com",
      "gemini-2.0-flash",
      true,
    );
    expect(r.generation).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse",
    );
  });

  it("model IDs are safely encoded (no double-slash in path)", () => {
    const r = buildGeminiUrl("https://generativelanguage.googleapis.com", "gemini-pro-1.0");
    expect(r.generation).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-1.0:generateContent",
    );
  });
});

/* ── Model list normalisation ───────────────────────────────────────── */

import { normaliseGeminiModelList } from "./gemini";

describe("normaliseGeminiModelList", () => {
  it("filters to generateContent models and strips models/ prefix", () => {
    const raw = [
      { name: "models/gemini-pro", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-pro-vision", supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
      // Should be excluded — not a generation model
      { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
    ];
    const result = normaliseGeminiModelList(raw);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("gemini-pro");
    expect(result[1].id).toBe("gemini-pro-vision");
  });

  it("handles empty input", () => {
    expect(normaliseGeminiModelList([])).toEqual([]);
  });
});