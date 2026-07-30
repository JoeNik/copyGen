// AI Proxy Service Worker
// Intercepts requests to /__ai_proxy__ and forwards them to the actual AI API endpoint.
// This avoids CORS issues by making the fetch from the service worker context.

const SW_VERSION = "v3";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === "/__ai_proxy__") {
    event.respondWith(handleProxy(event.request));
  }
});

/**
 * Headers that describe the *transport encoding* of the upstream body.
 *
 * `fetch()` already decompressed the body, so `response.body` is plain bytes.
 * Copying `content-encoding: gzip` (or a now-wrong `content-length`) onto the
 * forwarded Response makes the browser try to decompress the plain bytes a
 * second time; that fails at the network layer and surfaces in the page as a
 * bare "Failed to fetch" with no status code. Long JSON replies (the audit /
 * review calls) are the ones proxies actually gzip, which is why streaming
 * chapter generation appeared to work while auditing did not.
 */
const STRIPPED_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
]);

async function handleProxy(request) {
  let targetUrl;
  try {
    const payload = await request.json();
    targetUrl = payload.targetUrl;
    const { method, headers, body } = payload;

    if (!targetUrl) {
      return jsonError("代理请求缺少 targetUrl", 400);
    }

    const fetchOptions = {
      method: method || "POST",
      headers: headers || {},
    };
    if (body) {
      fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Forward the body as-is (including SSE streams / heartbeats) — do NOT buffer
    // or re-encode, long manual generation relies on streaming. Only rebuild the
    // headers so transport-encoding values don't describe the decoded body.
    const outHeaders = new Headers();
    response.headers.forEach((value, key) => {
      if (!STRIPPED_HEADERS.has(key.toLowerCase())) outHeaders.set(key, value);
    });
    outHeaders.set("Access-Control-Allow-Origin", "*");
    // Prevent intermediary caches from transforming the stream
    outHeaders.set("Cache-Control", "no-store");
    outHeaders.set("X-AI-Proxy", SW_VERSION);

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  } catch (error) {
    const detail = error && error.message ? error.message : String(error);
    const host = safeHost(targetUrl);
    return jsonError(
      `代理请求失败${host ? `（${host}）` : ""}：${detail}。请检查 API 地址、网络或代理设置。`,
      502
    );
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
      "X-AI-Proxy": SW_VERSION,
    },
  });
}
