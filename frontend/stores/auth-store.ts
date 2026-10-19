import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { cookieStorage } from "@/lib/cookie-storage";
import type { CurrentUser } from "@/lib/api-client/types/auth.types";

interface AuthState {
  token: string | null;
  user: CurrentUser | null;
  hasHydrated: boolean;
  setSession: (token: string, user: CurrentUser) => void;
  setUser: (user: CurrentUser) => void;
  logout: () => void;
  setHasHydrated: (value: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      hasHydrated: false,
      setSession: (token, user) => set({ token, user }),
      setUser: (user) => set({ user }),
      logout: () => set({ token: null, user: null }),
      setHasHydrated: (value) => set({ hasHydrated: value }),
    }),
    {
      name: "auth-token",
      storage: createJSONStorage(() => cookieStorage),
      // Only the user (for instant UI) is persisted. The access token lives in memory; the session is the httpOnly refresh cookie.
      partialize: (state) => ({ user: state.user }),
      // Ignore a token left in the cookie by the old long-lived-token auth.
      merge: (persisted, current) => ({ ...current, user: (persisted as { user?: CurrentUser | null } | undefined)?.user ?? null }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
