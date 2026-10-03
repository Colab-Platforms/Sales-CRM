"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { callingKeys } from "@/lib/api-client/queries/calling.queries";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:5000/api";

// Pushes the instant a call's transcript finishes, instead of the calls list polling for it - see
// backend/src/modules/calling/calling.events.ts + calling.controller.ts's streamCallTranscript.
// Not the native EventSource API - it can't send the Authorization header this app's auth relies on
// (apiClient uses a bearer token, not a cookie) - so this reads the SSE stream by hand via fetch's
// ReadableStream, same header as every other request. One short-lived connection per pending call;
// the server closes it itself once it sends the terminal event (or after its own timeout).
export function useCallTranscriptStream(leadId: string, callId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const token = useAuthStore((s) => s.token);

  useEffect(() => {
    if (!enabled || !token) return;
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/calling/calls/${callId}/transcript-stream`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sepIndex: number;
          while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, sepIndex);
            buffer = buffer.slice(sepIndex + 2);
            if (rawEvent.startsWith("data:")) {
              // The event body itself is redundant with a refetch - one round trip that's already
              // wired up for cache updates everywhere, rather than a second, parallel update path.
              queryClient.invalidateQueries({ queryKey: callingKeys.leadCalls(leadId) });
            }
          }
        }
      } catch {
        // Aborted on unmount/dep change, or a network hiccup - nothing to recover, the next normal
        // refetch of this lead's calls (e.g. opening the popup again) picks up the transcript anyway.
      }
    })();

    return () => controller.abort();
  }, [enabled, token, leadId, callId, queryClient]);
}
