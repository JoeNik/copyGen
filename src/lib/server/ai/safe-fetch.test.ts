import { describe, expect, it, vi } from "vitest";
import { safeFetch } from "./safe-fetch";

describe("safeFetch", () => {
  it("is defined", () => {
    expect(safeFetch).toBeInstanceOf(Function);
  });

  it("throws for blocked private address (smoke test via policy)", async () => {
    await expect(
      safeFetch("https://127.0.0.1", { method: "GET", timeoutMs: 1000 }),
    ).rejects.toThrow(/内网/);
  });

  it("does not send the request to the blocked URL (no real DNS needed)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await safeFetch("https://10.0.0.1", { method: "GET", timeoutMs: 500 });
    } catch {
      // expected
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});