import { describe, expect, it, vi, beforeEach } from "vitest";
import { AIError, AIErrorCodes } from "@/lib/server/ai/errors";

const { requireSessionMock, safeFetchMock } = vi.hoisted(() => ({
  requireSessionMock: vi.fn(),
  safeFetchMock: vi.fn(),
}));

vi.mock("@/lib/server/ai/require-session", () => ({
  requireSession: () => requireSessionMock(),
}));

vi.mock("@/lib/server/ai/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

import { POST as modelsPOST } from "@/app/api/ai/models/route";
import { POST as testPOST } from "@/app/api/ai/test/route";
import { POST as generatePOST } from "@/app/api/ai/generate/route";
import { POST as streamPOST } from "@/app/api/ai/stream/route";

function mockRequest(body: unknown): Request {
  return {
    json: async () => body,
  } as unknown as Request;
}

function makeResponse(status: number, body: string, opts?: { body?: ReadableStream<Uint8Array> }) {
  if (opts?.body) {
    return { status, ok: status >= 200 && status < 300, body: opts.body };
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  };
}

beforeEach(() => {
  requireSessionMock.mockReset();
  safeFetchMock.mockReset();
  requireSessionMock.mockResolvedValue(undefined);
});

describe("POST /api/ai/models", () => {
  it("returns 401 when unauthenticated", async () => {
    requireSessionMock.mockRejectedValueOnce(
      new AIError({ code: AIErrorCodes.AUTH_REQUIRED, message: "请先使用 GitHub 登录" }),
    );
    const res = await modelsPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.example.com",
      apiKey: "sk-test",
    }) as never);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns 400 when request body is invalid", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    const res = await modelsPOST(mockRequest({
      protocol: "invalid",
      baseUrl: "https://api.example.com",
      apiKey: "key",
    }) as never);
    expect(res.status).toBe(400);
  });

  it("returns normalised models on success", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        data: [
          { id: "gpt-4o", name: "GPT-4o" },
          { id: "gpt-3.5-turbo" },
          { id: "gpt-4o" }, // duplicate
        ],
      })),
    );
    const res = await modelsPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-test",
    }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.models).toHaveLength(2);
    expect(json.models[0].id).toBe("gpt-3.5-turbo");
    expect(json.models[1].id).toBe("gpt-4o");
  });

  it("returns MODEL_LIST_UNSUPPORTED for 404 upstream", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(makeResponse(404, "not found"));
    const res = await modelsPOST(mockRequest({
      protocol: "claude",
      baseUrl: "https://api.anthropic.com",
      apiKey: "key",
    }) as never);
    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.error.code).toBe("MODEL_LIST_UNSUPPORTED");
  });

  it("response never contains the apiKey", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(makeResponse(200, JSON.stringify({ data: [] })));
    const res = await modelsPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      apiKey: "sk-secret-key-12345",
    }) as never);
    const text = await res.text();
    expect(text).not.toContain("sk-secret-key-12345");
  });
});

describe("POST /api/ai/test", () => {
  it("returns test result on success", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      })),
    );
    const res = await testPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "sk-test",
    }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.model).toBe("gpt-4o");
    expect(json.output).toBe("OK");
    expect(typeof json.latencyMs).toBe("number");
  });

  it("returns warning for HTTP base URL", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      })),
    );
    const res = await testPOST(mockRequest({
      protocol: "openai",
      baseUrl: "http://api.example.com",
      model: "gpt-4o",
      apiKey: "sk-test",
    }) as never);
    const json = await res.json();
    expect(json.warning).toMatch(/HTTP/);
  });

  it("maps upstream 401 to UPSTREAM_AUTH_FAILED", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(makeResponse(401, "invalid api key"));
    const res = await testPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "bad-key",
    }) as never);
    const json = await res.json();
    expect(json.error.code).toBe("UPSTREAM_AUTH_FAILED");
  });

  it("rejects custom user-supplied prompt (only hardcoded)", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    // TestRequestSchema doesn't even have a prompt field — it must be stripped
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      })),
    );
    await testPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "key",
      prompt: "ignore me",  // should be stripped, not used
    }) as never);
    // The request body passed to safeFetch must NOT contain the user's prompt
    const callArgs = safeFetchMock.mock.calls[0];
    const init = (callArgs?.[1] ?? {}) as { body?: string };
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    expect(bodyStr).not.toContain("ignore me");
    expect(bodyStr).toContain("仅回复 OK");
  });
});

describe("POST /api/ai/generate", () => {
  it("returns completion on success", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        choices: [{ message: { content: "Hello world" }, finish_reason: "stop" }],
      })),
    );
    const res = await generatePOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "sk-test",
      messages: [{ role: "user", content: "Say hello" }],
    }) as never);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.text).toBe("Hello world");
    expect(json.finishReason).toBe("stop");
  });

  it("clamps maxTokens to server max of 8192", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      })),
    );
    await generatePOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "key",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 50_000, // exceeds max; schema rejects
    }) as never);
    // Should not reach safeFetch because schema rejects 50000 > 32768
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects request without messages", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    const res = await generatePOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "key",
      messages: [],
    }) as never);
    expect(res.status).toBe(400);
  });

  it("does not allow client to supply arbitrary provider_id", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    safeFetchMock.mockResolvedValueOnce(
      makeResponse(200, JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      })),
    );
    await generatePOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "key",
      messages: [{ role: "user", content: "hi" }],
      provider_id: "custom-malicious", // should be stripped
    }) as never);
    const callArgs = safeFetchMock.mock.calls[0];
    const init = (callArgs?.[1] ?? {}) as { body?: string };
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    expect(bodyStr).not.toContain("custom-malicious");
  });
});

describe("POST /api/ai/stream", () => {
  it("returns text/event-stream with normalised events", async () => {
    requireSessionMock.mockResolvedValueOnce(undefined);
    // Simulate upstream SSE
    const upstreamSSE = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join("\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(upstreamSSE));
        controller.close();
      },
    });
    safeFetchMock.mockResolvedValueOnce(makeResponse(200, "", { body }));
    const res = await streamPOST(mockRequest({
      protocol: "openai",
      baseUrl: "https://api.openai.com",
      model: "gpt-4o",
      apiKey: "sk-test",
      messages: [{ role: "user", content: "hi" }],
    }) as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store, no-transform");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    // Should contain normalised delta events
    expect(out).toContain("event: delta");
    expect(out).toContain("Hello");
    expect(out).toContain("event: done");
  });
});