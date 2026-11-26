"use client";

import { useCallback, useState } from "react";
import axios from "axios";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { BACKEND_URL, getErrorMessage } from "@/lib/api-client/client";
import type { ApiEnvelope } from "@/lib/api-client/types/common.types";
import type { CurrentUser } from "@/lib/api-client/types/auth.types";
import { clearDemoToken, saveDemoToken, type DemoRole } from "@/lib/demo";

interface DemoSessionReply {
  accessToken: string;
  user: CurrentUser;
}

/** Demo entry, demo-only role switch and exit. Nothing here touches the real session API: the demo service issues its own tokens. */
export function useDemo() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.logout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = useCallback(
    (reply: DemoSessionReply) => {
      // Cached data belongs to the previous role (queries are keyed by endpoint, not by user): drop it all.
      queryClient.clear();
      saveDemoToken(reply.accessToken);
      setSession(reply.accessToken, { ...reply.user, demo: true });
    },
    [queryClient, setSession],
  );

  const start = useCallback(
    async (accessCode?: string) => {
      setBusy(true);
      setError(null);
      try {
        // A bare request: no login header, no cookies, no real session involved.
        const res = await axios.post<ApiEnvelope<DemoSessionReply>>(`${BACKEND_URL}/demo/session`, accessCode ? { accessCode } : {}, { withCredentials: false });
        adopt(res.data.data);
        router.push("/dashboard");
      } catch (e) {
        setError(getErrorMessage(e, "The demo could not be started."));
      } finally {
        setBusy(false);
      }
    },
    [adopt, router],
  );

  const switchRole = useCallback(
    async (role: DemoRole) => {
      setBusy(true);
      setError(null);
      try {
        const { apiClient } = await import("@/lib/api-client/client");
        const res = await apiClient.post<ApiEnvelope<DemoSessionReply>>("/demo/session/role", { role });
        adopt(res.data.data);
        router.push("/dashboard");
      } catch (e) {
        setError(getErrorMessage(e, "The role could not be switched."));
      } finally {
        setBusy(false);
      }
    },
    [adopt, router],
  );

  /** Ends the demo and goes back to the demo landing page (or to the normal sign-in with `to`). */
  const exit = useCallback(
    (to: "/demo" | "/login" = "/demo") => {
      clearDemoToken();
      queryClient.clear();
      clearSession();
      router.push(to);
    },
    [clearSession, queryClient, router],
  );

  return { start, switchRole, exit, busy, error };
}
