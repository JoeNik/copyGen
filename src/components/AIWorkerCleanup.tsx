"use client";

import { useEffect } from "react";

/**
 * Unregisters the legacy AI-proxy Service Worker installed by previous app
 * versions. The AI transport now runs server-side, so `/ai-worker.js` is gone;
 * if its registration stayed active it would intercept `/__ai_proxy__` and
 * return stale 404 HTML, breaking older tabs left open.
 *
 * Runs after hydration and silently no-ops when Service Workers are unsupported
 * or when there are no matching registrations. Leaves unrelated Service
 * Workers (e.g. dev HMR workers) untouched.
 */
export default function AIWorkerCleanup() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    let cancelled = false;
    navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => {
        if (cancelled) return;
        for (const reg of registrations) {
          const scripts = [reg.active?.scriptURL, reg.waiting?.scriptURL, reg.installing?.scriptURL].filter(
            (s): s is string => typeof s === "string",
          );
          const isAiWorker = scripts.some((url) => {
            try {
              return new URL(url).pathname === "/ai-worker.js";
            } catch {
              return false;
            }
          });
          if (isAiWorker) {
            reg.unregister().catch(() => {
              // best-effort: a failed unregister does not break the page
            });
          }
        }
      })
      .catch(() => {
        // serviceWorker API present but getRegistrations failed — no-op
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}