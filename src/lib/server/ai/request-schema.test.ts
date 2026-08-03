import { describe, expect, it } from "vitest";
import { ProviderCredentialsSchema, GenerateRequestSchema, TestRequestSchema } from "./request-schema";

describe("ProviderCredentialsSchema", () => {
  it("accepts valid input", () => {
    const r = ProviderCredentialsSchema.parse({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
    });
    expect(r.protocol).toBe("openai");
    expect(r.baseUrl).not.toMatch(/\/$/);
  });

  it("rejects unknown protocol", () => {
    expect(() =>
      ProviderCredentialsSchema.parse({
        protocol: "custom",
        baseUrl: "https://example.com",
        apiKey: "key",
      }),
    ).toThrow();
  });

  it("rejects empty apiKey", () => {
    expect(() =>
      ProviderCredentialsSchema.parse({
        protocol: "openai",
        baseUrl: "https://example.com",
        apiKey: "",
      }),
    ).toThrow();
  });

  it("strips trailing slash from baseUrl", () => {
    const r = ProviderCredentialsSchema.parse({
      protocol: "openai",
      baseUrl: "https://api.example.com/",
      apiKey: "key",
    });
    expect(r.baseUrl).toBe("https://api.example.com");
  });

  it("rejects baseUrl that is too long", () => {
    expect(() =>
      ProviderCredentialsSchema.parse({
        protocol: "openai",
        baseUrl: "https://" + "x".repeat(600),
        apiKey: "key",
      }),
    ).toThrow();
  });

  it("rejects extra unknown fields", () => {
    const r = ProviderCredentialsSchema.parse({
      protocol: "openai",
      baseUrl: "https://example.com",
      apiKey: "key",
      extra: "should be stripped",
      arbitraryHeader: "injected",
    });
    expect(r).not.toHaveProperty("extra");
    expect(r).not.toHaveProperty("arbitraryHeader");
  });
});

describe("GenerateRequestSchema", () => {
  it("accepts valid input", () => {
    const r = GenerateRequestSchema.parse({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "sk-test",
      messages: [{ role: "user", content: "Hello" }],
    });
    expect(r.messages).toHaveLength(1);
  });

  it("rejects empty messages array", () => {
    expect(() =>
      GenerateRequestSchema.parse({
        protocol: "openai",
        baseUrl: "https://example.com",
        model: "gpt-4o",
        apiKey: "key",
        messages: [],
      }),
    ).toThrow();
  });

  it("rejects too many messages", () => {
    const msgs = Array.from({ length: 201 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    expect(() =>
      GenerateRequestSchema.parse({
        protocol: "openai",
        baseUrl: "https://example.com",
        model: "gpt-4o",
        apiKey: "key",
        messages: msgs,
      }),
    ).toThrow();
  });

  it("rejects maxTokens that exceeds server limits", () => {
    expect(() =>
      GenerateRequestSchema.parse({
        protocol: "openai",
        baseUrl: "https://example.com",
        model: "gpt-4o",
        apiKey: "key",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 100_000, // exceeds schema max of 32768
      }),
    ).toThrow();
  });

  it("rejects message content that is too long", () => {
    expect(() =>
      GenerateRequestSchema.parse({
        protocol: "openai",
        baseUrl: "https://example.com",
        model: "gpt-4o",
        apiKey: "key",
        messages: [{ role: "user", content: "x".repeat(100_000) }],
      }),
    ).toThrow();
  });

  it("rejects unknown fields being passed through", () => {
    const r = GenerateRequestSchema.parse({
      protocol: "openai",
      baseUrl: "https://example.com",
      model: "gpt-4o",
      apiKey: "key",
      messages: [{ role: "user", content: "Hi" }],
      provider_id: "custom-123",
    });
    expect(r).not.toHaveProperty("provider_id");
  });
});

describe("TestRequestSchema", () => {
  it("accepts valid input", () => {
    const r = TestRequestSchema.parse({
      protocol: "claude",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-test",
    });
    expect(r.protocol).toBe("claude");
  });

  it("rejects empty model", () => {
    expect(() =>
      TestRequestSchema.parse({
        protocol: "openai",
        baseUrl: "https://example.com",
        model: "",
        apiKey: "key",
      }),
    ).toThrow();
  });
});