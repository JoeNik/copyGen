import { promises as dns } from "node:dns";
import { AIErrorCodes } from "./errors";

/* ── Types ──────────────────────────────────────────────────────────── */

export interface ValidatedTarget {
  url: URL;
  addresses: string[];
  insecureHttp: boolean;
}

export type LookupFunction = (host: string) => Promise<string[]>;

/* ── Private IP range detection ─────────────────────────────────────── */

const CIDR_BLOCKED_V4: Array<{ prefix: bigint; mask: bigint; label: string }> = [];

function addCIDR(cidr: string, _label: string) {
  const [ipStr, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (typeof ipStr !== "string" || !Number.isFinite(bits)) return;
  const parts = ipStr.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return;
  let ip = BigInt(0);
  const eight = BigInt(8);
  for (const p of parts) ip = (ip << eight) | BigInt(p);
  const mask = bits === 0 ? BigInt(0) : (~BigInt(0) << BigInt(32 - bits)) & BigInt(0xffffffff);
  CIDR_BLOCKED_V4.push({ prefix: ip & mask, mask, label: _label });
}

addCIDR("0.0.0.0/8", "unspecified");
addCIDR("10.0.0.0/8", "RFC1918");
addCIDR("100.64.0.0/10", "CGNAT");
addCIDR("127.0.0.0/8", "loopback");
addCIDR("169.254.0.0/16", "link-local");
addCIDR("172.16.0.0/12", "RFC1918");
addCIDR("192.0.0.0/24", "IETF protocol");
addCIDR("192.0.2.0/24", "documentation");
addCIDR("192.168.0.0/16", "RFC1918");
addCIDR("198.18.0.0/15", "benchmark");
addCIDR("198.51.100.0/24", "documentation");
addCIDR("203.0.113.0/24", "documentation");
addCIDR("224.0.0.0/4", "multicast");
addCIDR("240.0.0.0/4", "reserved");

function isPrivateIPv4(s: string): boolean {
  const parts = s.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return false;
  let ip = BigInt(0);
  const eight = BigInt(8);
  for (const p of parts) ip = (ip << eight) | BigInt(p);
  return CIDR_BLOCKED_V4.some((r) => (ip & r.mask) === r.prefix);
}

function isPrivateIPv6(s: string): boolean {
  // Normalise: strip zone id, lowercase helper
  const zoneIdx = s.indexOf("%");
  const clean = zoneIdx >= 0 ? s.slice(0, zoneIdx) : s;
  const low = clean.toLowerCase();

  // ::1 loopback
  if (low === "::1" || low === "0:0:0:0:0:0:0:1") return true;
  // :: unspecified
  if (low === "::" || low === "0:0:0:0:0:0:0:0") return true;
  // fe80::/10 link-local
  if (low.startsWith("fe80")) return true;
  // fc00::/7 ULA
  if (low.startsWith("fc") || low.startsWith("fd")) return true;
  // ff00::/8 multicast
  if (low.startsWith("ff")) return true;

  // IPv4-mapped ::ffff:10.0.0.1 → check the embedded IPv4
  const mappedMatch = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) return isPrivateIPv4(mappedMatch[1]);

  return false;
}

/* ── URL validation ─────────────────────────────────────────────────── */

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);
const FORBIDDEN_HOSTNAMES = /(^|\.)localhost$/i;
// .local is a multicast-DNS TLD — safe to reject for production outbound
const DOT_LOCAL = /\.local$/i;

function isHostnameForbidden(hostname: string): boolean {
  return FORBIDDEN_HOSTNAMES.test(hostname) || DOT_LOCAL.test(hostname);
}

/* ── Public API ─────────────────────────────────────────────────────── */

export function isPrivateNetworkOptIn(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.AI_ALLOW_PRIVATE_NETWORK === "true"
  );
}

export async function validateOutboundTarget(
  rawUrl: string,
  options?: { defaultLookup?: LookupFunction },
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundPolicyError(AIErrorCodes.INVALID_BASE_URL, `无法解析 URL: ${rawUrl.slice(0, 120)}`);
  }

  // Scheme
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new OutboundPolicyError(AIErrorCodes.INVALID_BASE_URL, `不支持的协议: ${url.protocol}`);
  }

  // Credentials
  if (url.username || url.password) {
    throw new OutboundPolicyError(
      AIErrorCodes.INVALID_BASE_URL,
      `URL 不能包含用户凭据: ${url.host}`,
    );
  }

  const hostname = url.hostname;

  // Hostname-based checks (no DNS yet)
  if (isHostnameForbidden(hostname)) {
    throw new OutboundPolicyError(AIErrorCodes.PRIVATE_ADDRESS_BLOCKED, `禁止访问: ${hostname}`);
  }

  // Resolve DNS
  const lookupFn = options?.defaultLookup ?? defaultLookup;
  const addresses = await lookupFn(hostname);

  for (const addr of addresses) {
    const isV4 = !addr.includes(":");
    const isPrivate = isV4 ? isPrivateIPv4(addr) : isPrivateIPv6(addr);

    if (isPrivate && !isPrivateNetworkOptIn()) {
      throw new OutboundPolicyError(
        AIErrorCodes.PRIVATE_ADDRESS_BLOCKED,
        `地址 ${addr} 是内网/保留地址，禁止访问${hostname !== addr ? `（${hostname}）` : ""}`,
      );
    }
  }

  return {
    url,
    addresses,
    insecureHttp: url.protocol === "http:",
  };
}

/* ── Default DNS lookup ─────────────────────────────────────────────── */

export const defaultLookup: LookupFunction = async (host: string) => {
  const result = await dns.lookup(host, { all: true, verbatim: true });
  return result.map((e) => e.address);
};

/* ── Error ──────────────────────────────────────────────────────────── */

export class OutboundPolicyError extends Error {
  public readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboundPolicyError";
    this.code = code;
  }
}