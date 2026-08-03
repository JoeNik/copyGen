import { describe, expect, it, afterEach } from "vitest";
import { validateOutboundTarget } from "./outbound-policy";
import type { LookupFunction } from "./outbound-policy";

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Return this exact array for every host. */
function lookup(...addresses: string[]): LookupFunction {
  return async () => addresses;
}

/** The union of IPv4 "localhost" and IPv6 loopback. */
const LOCAL = lookup("127.0.0.1", "::1");

/** Public addresses. */
const PUBLIC_V4 = lookup("93.184.216.34");      // example.com
const PUBLIC_V6 = lookup("2606:2800:220:1:248:1893:25c8:1946");

/* ── Accept ─────────────────────────────────────────────────────────── */

describe("validateOutboundTarget – accept", () => {
  it("accepts a public HTTPS URL with IPv4", async () => {
    const t = await validateOutboundTarget("https://api.example.com/v1/chat", {
      defaultLookup: PUBLIC_V4,
    });
    expect(t.url.host).toBe("api.example.com");
    expect(t.insecureHttp).toBe(false);
    expect(t.addresses).toEqual(["93.184.216.34"]);
  });

  it("accepts a public HTTPS URL with IPv6", async () => {
    const t = await validateOutboundTarget("https://api.example.com", {
      defaultLookup: PUBLIC_V6,
    });
    expect(t.insecureHttp).toBe(false);
    expect(t.addresses).toContain("2606:2800:220:1:248:1893:25c8:1946");
  });

  it("accepts HTTP and marks as insecure", async () => {
    const t = await validateOutboundTarget("http://api.example.com", {
      defaultLookup: PUBLIC_V4,
    });
    expect(t.insecureHttp).toBe(true);
  });

  it("preserves the normalized URL", async () => {
    const t = await validateOutboundTarget("https://api.example.com:443/path?a=1", {
      defaultLookup: PUBLIC_V4,
    });
    expect(t.url.pathname).toBe("/path");
    expect(t.url.searchParams.get("a")).toBe("1");
  });
});

/* ── Reject by hostname ─────────────────────────────────────────────── */

describe("validateOutboundTarget – reject hostname", () => {
  it("rejects localhost", async () => {
    await expect(validateOutboundTarget("http://localhost:11434", { defaultLookup: LOCAL })).rejects.toThrow(/localhost/);
  });

  it("rejects 127.0.0.1 literal", async () => {
    await expect(validateOutboundTarget("http://127.0.0.1:11434", { defaultLookup: LOCAL })).rejects.toThrow(/127\.0\.0\.1/);
  });

  it("rejects *.localhost", async () => {
    await expect(
      validateOutboundTarget("http://my.localhost", {
        defaultLookup: lookup("127.0.0.1"),
      }),
    ).rejects.toThrow(/localhost/i);
  });

  it("rejects .local TLD", async () => {
    await expect(
      validateOutboundTarget("http://mybox.local", { defaultLookup: lookup("127.0.0.1") }),
    ).rejects.toThrow(/local/i);
  });
});

/* ── Reject by IP range ─────────────────────────────────────────────── */

describe("validateOutboundTarget – IP ranges", () => {

  it("rejects 10.x.x.x (RFC1918)", async () => {
    await expect(validateOutboundTarget("https://10.0.0.1", { defaultLookup: lookup("10.0.0.1") })).rejects.toThrow(/内网/);
  });

  it("rejects 172.16.0.1 (RFC1918)", async () => {
    await expect(validateOutboundTarget("https://172.16.0.1", { defaultLookup: lookup("172.16.0.1") })).rejects.toThrow(/内网/);
  });

  it("rejects 192.168.1.1 (RFC1918)", async () => {
    await expect(validateOutboundTarget("https://192.168.1.1", { defaultLookup: lookup("192.168.1.1") })).rejects.toThrow(/内网/);
  });

  it("rejects 169.254.169.254 (link-local / cloud metadata)", async () => {
    await expect(validateOutboundTarget("https://169.254.169.254", { defaultLookup: lookup("169.254.169.254") })).rejects.toThrow(/内网/);
  });

  it("rejects 0.0.0.0", async () => {
    await expect(validateOutboundTarget("https://0.0.0.0", { defaultLookup: lookup("0.0.0.0") })).rejects.toThrow(/内网/);
  });

  it("rejects 100.64.0.1 (CGNAT)", async () => {
    await expect(validateOutboundTarget("https://100.64.0.1", { defaultLookup: lookup("100.64.0.1") })).rejects.toThrow(/内网/);
  });

  it("rejects 224.0.0.1 (multicast)", async () => {
    await expect(validateOutboundTarget("https://224.0.0.1", { defaultLookup: lookup("224.0.0.1") })).rejects.toThrow(/内网/);
  });

  it("rejects 198.18.0.1 (benchmark)", async () => {
    await expect(validateOutboundTarget("https://198.18.0.1", { defaultLookup: lookup("198.18.0.1") })).rejects.toThrow(/内网/);
  });

  it("rejects ::1 (IPv6 loopback)", async () => {
    await expect(validateOutboundTarget("https://[::1]", { defaultLookup: lookup("::1") })).rejects.toThrow(/内网/);
  });

  it("rejects fc00:: (IPv6 ULA)", async () => {
    await expect(validateOutboundTarget("https://[fc00::1]", { defaultLookup: lookup("fc00::1") })).rejects.toThrow(/内网/);
  });

  it("rejects fe80:: (IPv6 link-local)", async () => {
    await expect(validateOutboundTarget("https://[fe80::1]", { defaultLookup: lookup("fe80::1") })).rejects.toThrow(/内网/);
  });

  it("rejects ff00:: (IPv6 multicast)", async () => {
    await expect(validateOutboundTarget("https://[ff02::1]", { defaultLookup: lookup("ff02::1") })).rejects.toThrow(/内网/);
  });

  it("rejects IPv4-mapped private ::ffff:10.0.0.1", async () => {
    await expect(validateOutboundTarget("https://some.internal", { defaultLookup: lookup("::ffff:10.0.0.1") })).rejects.toThrow(/内网/);
  });
});

/* ── Reject by URL structure ────────────────────────────────────────── */

describe("validateOutboundTarget – URL", () => {
  it("rejects username in URL", async () => {
    await expect(
      validateOutboundTarget("https://user@api.example.com", { defaultLookup: PUBLIC_V4 }),
    ).rejects.toThrow(/URL 不能包含/);
  });

  it("rejects password in URL", async () => {
    await expect(
      validateOutboundTarget("https://user:pass@api.example.com", { defaultLookup: PUBLIC_V4 }),
    ).rejects.toThrow(/URL 不能包含/);
  });

  it("rejects unsupported scheme", async () => {
    await expect(
      validateOutboundTarget("ftp://example.com", { defaultLookup: PUBLIC_V4 }),
    ).rejects.toThrow(/不支持的协议/);
  });

  it("rejects ftp scheme", async () => {
    await expect(
      validateOutboundTarget("ftp://example.com", { defaultLookup: PUBLIC_V4 }),
    ).rejects.toThrow(/不支持的协议/);
  });
});

/* ── Development overrides ──────────────────────────────────────────── */

describe("validateOutboundTarget – dev-mode opt-in", () => {
  const origEnv = (process.env as { NODE_ENV?: string }).NODE_ENV;
  const origFlag = process.env.AI_ALLOW_PRIVATE_NETWORK;

  afterEach(() => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = origEnv;
    process.env.AI_ALLOW_PRIVATE_NETWORK = origFlag;
  });

  it("allows RFC1918 when NODE_ENV is not production and flag is true", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "development";
    process.env.AI_ALLOW_PRIVATE_NETWORK = "true";
    const t = await validateOutboundTarget("https://192.168.1.1", {
      defaultLookup: lookup("192.168.1.1"),
    });
    expect(t.addresses).toContain("192.168.1.1");
  });

  it("blocks private when NODE_ENV=production even with flag set", async () => {
    (process.env as { NODE_ENV?: string }).NODE_ENV = "production";
    process.env.AI_ALLOW_PRIVATE_NETWORK = "true";
    await expect(
      validateOutboundTarget("https://10.0.0.1", { defaultLookup: lookup("10.0.0.1") }),
    ).rejects.toThrow(/内网/);
  });

  it("blocks private in test environment", async () => {
    // Vitest defaults: NODE_ENV=test, AI_ALLOW_PRIVATE_NETWORK undefined
    await expect(
      validateOutboundTarget("https://10.0.0.1", { defaultLookup: lookup("10.0.0.1") }),
    ).rejects.toThrow(/内网/);
  });
});

/* ── Mixed address resolution ───────────────────────────────────────── */

describe("validateOutboundTarget – mixed resolution", () => {
  it("rejects when ANY resolved address is private", async () => {
    await expect(
      validateOutboundTarget("https://dual-stack.example", {
        defaultLookup: lookup("93.184.216.34", "10.0.0.1"),
      }),
    ).rejects.toThrow(/内网/);
  });

  it("accepts when ALL addresses are public", async () => {
    const t = await validateOutboundTarget("https://dual-stack.example", {
      defaultLookup: lookup("93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"),
    });
    expect(t.addresses).toHaveLength(2);
  });

  it("rejects 0.0.0.0 mixed with public", async () => {
    await expect(
      validateOutboundTarget("https://weird.example", {
        defaultLookup: lookup("93.184.216.34", "0.0.0.0"),
      }),
    ).rejects.toThrow(/内网/);
  });
});

/* ── Error messages ─────────────────────────────────────────────────── */

describe("validateOutboundTarget – safe error messages", () => {
  it("includes hostname in error, not path or query", async () => {
    let err: Error | undefined;
    try {
      await validateOutboundTarget("http://localhost:11434/v1/models?key=sk-secret", { defaultLookup: LOCAL });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    // error must NOT contain the API key or the full path
    expect(err!.message).not.toContain("sk-secret");
    // should mention the host
    expect(err!.message).toMatch(/localhost/i);
  });
});