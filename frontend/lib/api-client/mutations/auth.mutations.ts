import { useMutation } from "@tanstack/react-query";
import { authApi } from "../endpoints/auth.api";
import type { LoginPayload, LoginResult } from "../types/auth.types";

export function useLoginMutation() {
  return useMutation<LoginResult, unknown, LoginPayload>({
    mutationFn: (payload) => authApi.login(payload),
  });
}
