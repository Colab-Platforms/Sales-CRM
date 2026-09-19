"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth-store";
import { useLoginMutation } from "@/lib/api-client/mutations/auth.mutations";
import { getErrorMessage } from "@/lib/api-client/client";
import type { LoginPayload } from "@/lib/api-client/types/auth.types";

export function useAuth() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.logout);

  const loginMutation = useLoginMutation();

  const login = useCallback(
    (payload: LoginPayload) => {
      loginMutation.mutate(payload, {
        onSuccess: (result) => {
          setSession(result.accessToken, result.user);
          router.push("/dashboard");
        },
      });
    },
    [loginMutation, setSession, router],
  );

  const logout = useCallback(() => {
    clearSession();
    router.push("/login");
  }, [clearSession, router]);

  return {
    user,
    token,
    isAuthenticated: Boolean(token),
    login,
    logout,
    isLoggingIn: loginMutation.isPending,
    loginError: loginMutation.error ? getErrorMessage(loginMutation.error, "Invalid email or password.") : null,
  };
}
