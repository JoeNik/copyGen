import { request, Agent, type Dispatcher } from "undici";
import { validateOutboundTarget } from "./outbound-policy";
import { OutboundPolicyError } from "./outbound-policy";

/**
 * Fetch an external AI provider through a pinned, validated outbound connection.
 *
 * 1. Validates the URL against the private-network policy.
 * 2. Resolves the host via the policy's lookup so every returned address is
 *    public (when production).
 * 3. Uses undici with a request-local Agent that pins the connection to one
 *    validated address — the Host/SNI still carries the original hostname so
 *    the upstream sees the right virtual host but the TCP connection never
 *    reaches an unintended IP.
 * 4. Does NOT follow redirects (maxRedirections: 0).
 * 5. Timeout aborts via AbortSignal.timeout.
 *
 * Returns a web `Response` shaped object exposing `.status`, `.ok`, and a
 * `.body` ReadableStream<Uint8Array> plus a `.text()` helper.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const validated = await validateOutboundTarget(rawUrl);
  const { url, addresses } = validated;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), init.timeoutMs ?? 30000);

  const targetAddress = addresses[0];
  const isV6 = targetAddress.includes(":");

  // Request-local dispatcher with pinned IP lookup. undici's request() does
  // not follow redirects unless maxRedirections is set, so the upstream 3xx
  // surfaces as the response status and is handled by the caller.
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, _opts, cb) => {
        cb(null, [{ address: targetAddress, family: isV6 ? 6 : 4 }]);
      },
    },
  });

  try {
    const responseData = await request(url.toString(), {
      method: (init.method as Dispatcher.HttpMethod) ?? "POST",
      headers: init.headers as Record<string, string>,
      body: init.body as string | Buffer | undefined,
      dispatcher,
      signal: controller.signal,
    });

    clearTimeout(timer);

    // Build a web Response from undici's ResponseData. We deliberately do NOT
    // copy upstream headers: undici's headers object carries Symbol-keyed
    // entries (e.g. Symbol(sensitiveHeaders)) that the web Headers constructor
    // rejects with "cannot be converted to a ByteString". Callers only need
    // status and body, so we pass those alone.
    const status = responseData.statusCode;
    const body = responseData.body as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status });
  } catch (err) {
    clearTimeout(timer);
    await dispatcher.close().catch(() => {});
    if (err instanceof Error && err.name === "AbortError") {
      throw new OutboundPolicyError("UPSTREAM_TIMEOUT", "上游接口超时");
    }
    throw err;
  }
}