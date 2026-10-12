"use client";

import { useEffect, useRef } from "react";
import { useAuthStore } from "@/stores/auth-store";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:5000/api";

// The server pings every 25s, so 60s of silence means the connection is dead even if the browser
// hasn't noticed (sleep/Wi-Fi drop).
const STALE_AFTER_MS = 60_000;
const WATCHDOG_EVERY_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * Holds one long-lived SSE connection open and calls `onEvent` with each parsed `data:` payload.
 * Not the native EventSource - it can't send the bearer token this app's auth uses - so the stream is
 * read by hand from fetch, like components/leads/use-call-transcript-stream.ts. Reconnects with
 * backoff, and reconnects at once when a hidden tab becomes visible with a stale connection.
 */
export function useSseStream<T>(path: string, onEvent: (event: T) => void, enabled: boolean) {
  const token = useAuthStore((s) => s.token);
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    if (!enabled || !token) return;

    let stopped = false;
    let controller: AbortController | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let lastChunkAt = Date.now();
    let attempt = 0;

    const connect = async () => {
      controller = new AbortController();
      lastChunkAt = Date.now();
      try {
        const res = await fetch(`${BACKEND_URL}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        // Expired/invalid token: the axios 401 handler logs out on the next normal request; don't hammer.
        if (res.status === 401 || res.status === 403) return;
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastChunkAt = Date.now();
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            // Lines starting with ":" are keep-alive pings - they only matter for lastChunkAt above.
            if (!raw.startsWith("data:")) continue;
            try {
              handlerRef.current(JSON.parse(raw.slice(5).trim()) as T);
            } catch {
              // A malformed event is skipped; the stream itself is fine.
            }
          }
        }
      } catch {
        // Aborted (unmount / stale watchdog) or a network error - fall through to the retry below.
      }
      if (!stopped) {
        retryTimer = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt));
        attempt += 1;
      }
    };

    const dropIfStale = () => {
      if (Date.now() - lastChunkAt > STALE_AFTER_MS) controller?.abort();
    };
    const watchdog = setInterval(dropIfStale, WATCHDOG_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") dropIfStale();
    };
    document.addEventListener("visibilitychange", onVisible);

    void connect();

    return () => {
      stopped = true;
      clearInterval(watchdog);
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, [path, enabled, token]);
}
