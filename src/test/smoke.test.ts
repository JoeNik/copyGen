import { describe, expect, it } from "vitest";

describe("test harness", () => {
  it("resolves the application alias", async () => {
    const mod = await import("@/lib/utils");
    expect(mod).toBeDefined();
  });
});
