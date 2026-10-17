import Cookies from "js-cookie";
import type { StateStorage } from "zustand/middleware";

const COOKIE_OPTIONS = {
  expires: 30, // days — matches backend REFRESH_TOKEN_TTL_DAYS; this cookie only hints the signed-in user, it holds no token
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};

export const cookieStorage: StateStorage = {
  getItem: (name) => Cookies.get(name) ?? null,
  setItem: (name, value) => {
    Cookies.set(name, value, COOKIE_OPTIONS);
  },
  removeItem: (name) => {
    Cookies.remove(name, { path: "/" });
  },
};
