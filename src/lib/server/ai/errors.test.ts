import { describe, expect, it } from "vitest";
import { AIError, AIErrorCodes, classifyUpstreamStatus, sanitiseUpstreamBody } from "./errors";

describe("AIError", () => {
  it("carries the code and message from the payload", () => {
    const err = new AIError({ code: AIErrorCodes.AUTH_REQUIRED, message: "login required" });
    expect(err.code).toBe("AUTH_REQUIRED");
    expect(err.message).toBe("login required");
  });

  it("toJSON() returns the stable shape without stack", () => {
    const err = new AIError({
      code: AIErrorCodes.UPSTREAM_TIMEOUT,
      message: "timeout",
      status: 504,
      host: "api.example.com",
      requestId: "req-1",
    });
    const json = err.toJSON();
    expect(json).not.toHaveProperty("stack");
    expect(json).not.toHaveProperty("key");
    expect(json.code).toBe("UPSTREAM_TIMEOUT");
    expect(json.status).toBe(504);
    expect(json.host).toBe("api.example.com");
    expect(json.requestId).toBe("req-1");
  });

  it("toJSON() suggestion is empty for unclassified codes", () => {
    const err = new AIError({ code: AIErrorCodes.INVALID_REQUEST, message: "bad" });
    expect(err.toJSON().suggestion).toBeTruthy();
  });
});

describe("classifyUpstreamStatus", () => {
  it("returns AUTH_FAILED for 401", () => {
    expect(classifyUpstreamStatus(401).code).toBe("UPSTREAM_AUTH_FAILED");
  });

  it("returns AUTH_FAILED for 403", () => {
    expect(classifyUpstreamStatus(403).code).toBe("UPSTREAM_AUTH_FAILED");
  });

  it("returns MODEL_NOT_FOUND for 404 with model keyword in body", () => {
    const r = classifyUpstreamStatus(404, '{"error":"model not found"}');
    expect(r.code).toBe("MODEL_NOT_FOUND");
  });

  it("returns UPSTREAM_HTTP_ERROR for 404 without model keyword", () => {
    expect(classifyUpstreamStatus(404, "not found").code).toBe("UPSTREAM_HTTP_ERROR");
  });

  it("returns RATE_LIMITED for 429", () => {
    expect(classifyUpstreamStatus(429).code).toBe("UPSTREAM_RATE_LIMITED");
  });

  it("returns UPSTREAM_HTTP_ERROR for 5xx", () => {
    expect(classifyUpstreamStatus(502).code).toBe("UPSTREAM_HTTP_ERROR");
    expect(classifyUpstreamStatus(503).code).toBe("UPSTREAM_HTTP_ERROR");
  });

  it("returns UPSTREAM_HTTP_ERROR for other non-2xx", () => {
    expect(classifyUpstreamStatus(418).code).toBe("UPSTREAM_HTTP_ERROR");
  });
});

describe("sanitiseUpstreamBody", () => {
  it("returns first 200 characters of a long body", () => {
    const long = "a".repeat(500);
    expect(sanitiseUpstreamBody(long).length).toBe(200);
  });

  it("strips control characters except newline and tab", () => {
    const input = "hel\x00lo\x1fworld";
    expect(sanitiseUpstreamBody(input)).toBe("helloworld");
  });
});