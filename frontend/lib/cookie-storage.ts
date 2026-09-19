import Cookies from "js-cookie";
import type { StateStorage } from "zustand/middleware";

const COOKIE_OPTIONS = {
  expires: 1, // days — matches backend JWT_EXPIRES_IN=1d
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
