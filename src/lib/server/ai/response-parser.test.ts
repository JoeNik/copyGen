import { describe, expect, it } from "vitest";
import { parseAIResponse } from "./response-parser";

/* ── Pure JSON payloads (non-stream) ────────────────────────────────── */

describe("parseAIResponse – pure JSON", () => {
  it("returns text from an OpenAI completion", () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "Hello" }, finish_reason: "stop" }],
    });
    expect(parseAIResponse(body, "openai")).toEqual({ text: "Hello", finishReason: "stop" });
  });

  it("returns text from a Claude non-stream response", () => {
    const body = JSON.stringify({
      content: [{ type: "text", text: "Hi Claude" }],
      stop_reason: "end_turn",
    });
    expect(parseAIResponse(body, "claude")).toEqual({ text: "Hi Claude", finishReason: "end_turn" });
  });

  it("returns text from a Gemini response", () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "Gemini reply" }] }, finishReason: "STOP" }],
    });
    expect(parseAIResponse(body, "gemini")).toEqual({ text: "Gemini reply", finishReason: "STOP" });
  });

  it("rejects an OpenAI error body", () => {
    const body = JSON.stringify({ error: { message: "invalid model" } });
    expect(() => parseAIResponse(body, "openai")).toThrow(/invalid model/);
  });

  it("returns empty text from an empty choices array", () => {
    const body = JSON.stringify({ choices: [] });
    const result = parseAIResponse(body, "openai");
    expect(result.text).toBe("");
  });

  it("returns empty text from empty but valid response", () => {
    const body = JSON.stringify({ choices: [{ message: { content: null }, finish_reason: "stop" }] });
    const result = parseAIResponse(body, "openai");
    expect(result.text).toBe("");
  });

  it("picks delta content over message for streaming-origin body", () => {
    const body = JSON.stringify({ choices: [{ delta: { content: "delta" }, message: { content: "msg" }, finish_reason: null }] });
    // delta present → finish_reason resolves to "continue"
    expect(parseAIResponse(body, "openai").text).toBe("delta");
  });
});

/* ── SSE / NDJSON (heartbeat-polluted) ──────────────────────────────── */

describe("parseAIResponse – SSE / NDJSON", () => {
  it("assembles OpenAI SSE deltas", () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}',
      'data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}',
      'data: [DONE]',
    ].join("\n");
    expect(parseAIResponse(lines, "openai")).toEqual({ text: "Hello world", finishReason: "stop" });
  });

  it("strips SSE heartbeats and event/retry meta-lines", () => {
    const lines = [
      ": heartbeat",
      "event: ping",
      "id: 1",
      "retry: 3000",
      'data: {"choices":[{"delta":{"content":"A"},"finish_reason":"stop"}]}',
    ].join("\n");
    expect(parseAIResponse(lines, "openai")).toEqual({ text: "A", finishReason: "stop" });
  });

  it("handles Claude content_block_delta and message_delta", () => {
    const lines = [
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
      'data: {"type":"message_stop"}',
    ].join("\n");
    expect(parseAIResponse(lines, "claude")).toEqual({ text: "Hello world", finishReason: "end_turn" });
  });

  it("handles Gemini SSE chunks", () => {
    const lines = [
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi "}]},"finishReason":"STOP"}]}',
      'data: {"candidates":[{"content":{"parts":[{"text":"there"}]},"finishReason":"STOP"}]}',
    ].join("\n");
    expect(parseAIResponse(lines, "gemini")).toEqual({ text: "Hi there", finishReason: "STOP" });
  });

  it("rejects an SSE error body", () => {
    const lines = [
      'data: {"error":{"message":"rate limit exceeded"}}',
    ].join("\n");
    expect(() => parseAIResponse(lines, "openai")).toThrow(/rate limit/);
  });

  it("skips malformed non-JSON data lines", () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      "data: this is not json",
    ].join("\n");
    expect(parseAIResponse(lines, "openai")).toEqual({ text: "ok", finishReason: "stop" });
  });

  it("recovers from a single malformed JSON line between good ones", () => {
    const lines = [
      'data: {"choices":[{"delta":{"content":"A"},"finish_reason":"continue"}]}',
      "event: flush",
      'data: {"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}',
    ].join("\n");
    expect(parseAIResponse(lines, "openai")).toEqual({ text: "AB", finishReason: "stop" });
  });
});

/* ── Empty / invalid bodies ─────────────────────────────────────────── */

describe("parseAIResponse – empty/invalid", () => {
  it("throws INVALID_UPSTREAM_RESPONSE for empty body", () => {
    expect(() => parseAIResponse("", "openai")).toThrow(/空响应/);
  });

  it("throws INVALID_UPSTREAM_RESPONSE for whitespace-only body", () => {
    expect(() => parseAIResponse("  \n  ", "openai")).toThrow(/空响应/);
  });

  it("throws INVALID_UPSTREAM_RESPONSE for body with only SSE comments", () => {
    expect(() => parseAIResponse(": keepalive\n: heartbeat", "openai")).toThrow(/无法从/);
  });

  it("last resort: finds JSON object in otherwise junk text", () => {
    const body =
      "some wrapper text\n" +
      JSON.stringify({ choices: [{ message: { content: "got it" }, finish_reason: "stop" }] }) +
      "\nmore text";
    expect(parseAIResponse(body, "openai")).toEqual({ text: "got it", finishReason: "stop" });
  });
});