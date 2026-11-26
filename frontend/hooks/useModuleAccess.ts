"use client";

import { useAuthStore } from "@/stores/auth-store";
import { isPathBlocked } from "@/lib/module-access";

/** Whether the signed-in user may open a page path (false for a module restricted for them). */
export function useCanOpenPath() {
  const blocked = useAuthStore((s) => s.user?.blockedModules);
  return (path: string) => !isPathBlocked(path, blocked);
}
