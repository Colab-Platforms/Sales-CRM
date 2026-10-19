import axios, { type InternalAxiosRequestConfig } from "axios";
import { useAuthStore } from "@/stores/auth-store";
import type { CurrentUser } from "@/lib/api-client/types/auth.types";

const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:5000/api";

// withCredentials: the httpOnly refresh cookie is set by /auth/login and used by /auth/refresh and /auth/logout (cross-origin in production).
export const apiClient = axios.create({
  baseURL: BACKEND_URL,
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

/** Sent on cookie-authenticated calls: the backend rejects them without it, which blocks cross-site form posts (CSRF). */
export const AJAX_HEADERS = { "X-Requested-With": "XMLHttpRequest" } as const;

const MAX_REFRESH_MARGIN_MS = 60_000;

/** Reads the expiry (ms) and how long before it the token should be renewed, from a JWT without verifying it; the server is the one that verifies. */
function tokenTiming(token: string): { expiry: number; margin: number } | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof payload.exp !== "number") return null;
    const lifetime = typeof payload.iat === "number" ? (payload.exp - payload.iat) * 1000 : MAX_REFRESH_MARGIN_MS * 5;
    // Renew in the last fifth of the token's life (at most 60s), so a very short token isn't refreshed on every request.
    return { expiry: payload.exp * 1000, margin: Math.min(MAX_REFRESH_MARGIN_MS, lifetime / 5) };
  } catch {
    return null;
  }
}

// Access tokens are short-lived and kept in memory only. The session itself is the httpOnly refresh cookie: when the access token is
// about to expire (or already has, e.g. after a page reload) it is swapped via /auth/refresh, which also rotates the cookie.
// One shared promise so a burst of parallel requests triggers a single refresh.
let refreshing: Promise<boolean> | null = null;

/** Gets a new access token from the refresh cookie. true = signed in; false = no valid session (store cleared); throws on a network/server fault, leaving the session as it was. */
export function restoreSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = axios
      .post<{ data: { accessToken: string; user: CurrentUser } }>(`${BACKEND_URL}/auth/refresh`, {}, { headers: AJAX_HEADERS, withCredentials: true })
      .then((res) => {
        useAuthStore.getState().setSession(res.data.data.accessToken, res.data.data.user);
        return true;
      })
      .catch((error) => {
        if (axios.isAxiosError(error) && error.response && (error.response.status === 401 || error.response.status === 403)) {
          useAuthStore.getState().logout();
          return false;
        }
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

const isAuthCall = (url?: string) => Boolean(url && /^\/auth\/(login|refresh|logout)/.test(url));

apiClient.interceptors.request.use(async (config) => {
  if (!isAuthCall(config.url)) {
    const current = useAuthStore.getState().token;
    const timing = current ? tokenTiming(current) : null;
    if (timing && timing.expiry - Date.now() < timing.margin) {
      await restoreSession().catch(() => {});
    }
  }
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      const config = error.config as RetriableConfig | undefined;
      if (isAuthCall(config?.url)) return Promise.reject(error); // a wrong password is a 401 too
      // A request that carried a session gets one refresh-and-retry before the user is logged out.
      if (config && !config._retried && useAuthStore.getState().token) {
        config._retried = true;
        try {
          if (await restoreSession()) return apiClient(config);
        } catch {
          // Network/server fault while refreshing: keep the session, surface the original 401.
        }
        return Promise.reject(error);
      }
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

// Keep the in-memory token fresh while the app is open (long-lived streams such as SSE reconnect with it), by refreshing shortly before expiry. (This also keeps an open, active app signed in; the refresh cookie only expires after it has been idle past its limit.)
if (typeof window !== "undefined") {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (token: string | null) => {
    clearTimeout(timer);
    const timing = token ? tokenTiming(token) : null;
    if (!timing) return;
    timer = setTimeout(() => void restoreSession().catch(() => {}), Math.max(timing.expiry - Date.now() - timing.margin, 2_000));
  };
  useAuthStore.subscribe((state, prev) => {
    if (state.token !== prev.token) schedule(state.token);
  });
}

export function getErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string } | undefined;
    return data?.message ?? fallback;
  }
  return fallback;
}
