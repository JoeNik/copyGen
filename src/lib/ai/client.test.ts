// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";

const getActiveProviderMock = vi.fn();
vi.mock("@/lib/storage", () => ({
  getActiveProvider: () => getActiveProviderMock(),
}));

import { generateAI, streamAI, AIClientError } from "@/lib/ai/client";

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProviderMock.mockReturnValue({
    protocol: "openai",
    baseUrl: "https://api.openai.com",
    model: "gpt-4o",
    apiKey: "sk-test-key",
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generateAI", () => {
  it("posts to /api/ai/generate with credentials and messages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { text: "Hello", finishReason: "stop" }),
    );
    const result = await generateAI([{ role: "user", content: "hi" }], 200);
    expect(result.text).toBe("Hello");
    expect(result.finishReason).toBe("stop");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/ai/generate");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.apiKey).toBe("sk-test-key");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect((init as RequestInit).credentials).toBe("same-origin");
  });

  it("throws AIClientError with the server error code on failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(401, {
        error: { code: "AUTH_REQUIRED", message: "请先登录" },
      }),
    );
    await expect(generateAI([{ role: "user", content: "hi" }], 100)).rejects.toMatchObject({
      name: "AIClientError",
      code: "AUTH_REQUIRED",
    });
  });

  it("throws PROVIDER_NOT_CONFIGURED when no active provider", async () => {
    getActiveProviderMock.mockReturnValue(null);
    await expect(generateAI([{ role: "user", content: "hi" }], 100)).rejects.toMatchObject({
      code: "PROVIDER_NOT_CONFIGURED",
    });
  });

  it("never sends extra header fields beyond credentials+messages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { text: "ok", finishReason: "stop" }),
    );
    await generateAI([{ role: "user", content: "hi" }], 100);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body).sort()).toEqual(
      ["apiKey", "baseUrl", "maxTokens", "messages", "model", "protocol"].sort(),
    );
  });
});

describe("streamAI", () => {
  function streamResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }

  it("assembles deltas and captures finishReason", async () => {
    const sse = [
      'event: delta\ndata: {"text":"Hello"}\n\n',
      'event: delta\ndata: {"text":" world"}\n\n',
      'event: done\ndata: {"finishReason":"stop"}\n\n',
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse(sse));
    const result = await streamAI([{ role: "user", content: "hi" }], 100);
    expect(result.text).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
  });

  it("throws AIClientError on an error event", async () => {
    const sse = ['event: error\ndata: {"code":"UPSTREAM_TIMEOUT","message":"timeout"}\n\n'];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(streamResponse(sse));
    await expect(streamAI([{ role: "user", content: "hi" }], 100)).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
    });
  });

  it("throws on non-2xx HTTP status with the server error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(502, {
        error: { code: "UPSTREAM_UNREACHABLE", message: "无法连接" },
      }),
    );
    await expect(streamAI([{ role: "user", content: "hi" }], 100)).rejects.toMatchObject({
      code: "UPSTREAM_UNREACHABLE",
    });
  });
});

describe("AIClientError", () => {
  it("exposes code and status", () => {
    const e = new AIClientError("UPSTREAM_TIMEOUT", "timed out", 504);
    expect(e.code).toBe("UPSTREAM_TIMEOUT");
    expect(e.status).toBe(504);
    expect(e.message).toBe("timed out");
  });
});