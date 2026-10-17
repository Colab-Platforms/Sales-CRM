"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth-store";
import { restoreSession } from "@/lib/api-client/client";
import { meQueryOptions } from "@/lib/api-client/queries/auth.queries";

export function AuthGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const token = useAuthStore((s) => s.token);
  const setUser = useAuthStore((s) => s.setUser);

  // The access token lives in memory only, so after a reload or a new tab it is restored from the httpOnly
  // refresh cookie before anything renders. No valid cookie leaves `token` null, which redirects to /login below.
  const [restoreDone, setRestoreDone] = useState(false);
  const restoring = !token && !restoreDone;
  useEffect(() => {
    if (!hasHydrated || useAuthStore.getState().token) return;
    let cancelled = false;
    restoreSession()
      .catch(() => false)
      .finally(() => {
        if (!cancelled) setRestoreDone(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hasHydrated]);

  // Validate the in-memory token against the backend, not just its presence.
  // A 401 here is caught by the axios interceptor (one refresh-and-retry, then it clears the session) —
  // that flips `token` to null and the effect below redirects to /login.
  const meQuery = useQuery({
    ...meQueryOptions(),
    enabled: hasHydrated && Boolean(token),
  });

  useEffect(() => {
    if (meQuery.data) {
      setUser(meQuery.data);
    }
  }, [meQuery.data, setUser]);

  useEffect(() => {
    if (hasHydrated && !restoring && !token) {
      router.replace("/login");
    }
  }, [hasHydrated, restoring, token, router]);

  if (!hasHydrated || restoring || !token || meQuery.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
