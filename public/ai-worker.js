// AI Proxy Service Worker
// Intercepts requests to /__ai_proxy__ and forwards them to the actual AI API endpoint.
// This avoids CORS issues by making the fetch from the service worker context.

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

async function handleProxy(request) {
  try {
    const { targetUrl, method, headers, body } = await request.json();

    const fetchOptions = {
      method: method || "POST",
      headers: headers || {},
    };
    if (body) {
      fetchOptions.body = typeof body === "string" ? body : JSON.stringify(body);
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Forward body as-is (including SSE streams / heartbeats).
    // Do NOT buffer or re-encode — long manual generation relies on streaming.
    const outHeaders = new Headers(response.headers);
    outHeaders.set("Access-Control-Allow-Origin", "*");
    // Prevent intermediary caches from transforming the stream
    outHeaders.set("Cache-Control", "no-store");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: outHeaders,
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: `Proxy error: ${error.message}` }),
      {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
}
