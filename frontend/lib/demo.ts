// DEMO MODE (client side). A demo session is a separate kind of session: its token is issued by the demo service (never by /auth/login), it lives in sessionStorage
// for this tab only, and every API request it makes is rewritten to the demo service (see lib/api-client/client.ts), so none can reach the normal CRM routes.
// The server enforces all of this independently: a demo token is not valid for the real API, and the demo service refuses writes and integrations.
import type { CurrentUser, Role } from "@/lib/api-client/types/auth.types";

export const DEMO_TOKEN_KEY = "crm-demo-token";
export const DEMO_PATH_PREFIX = "/demo";

export type DemoRole = Extract<Role, "ADMIN" | "MANAGER" | "SALESPERSON">;
export const DEMO_ROLE_OPTIONS: { value: DemoRole; label: string }[] = [
  { value: "ADMIN", label: "Admin" },
  { value: "MANAGER", label: "Manager" },
  { value: "SALESPERSON", label: "Telecaller" },
];
export const demoRoleLabel = (role: Role): string => DEMO_ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;

export const isDemoUser = (user: Pick<CurrentUser, "demo"> | null | undefined): boolean => user?.demo === true;

/** The request path for a demo session: always under /demo, so nothing is sent to a normal route. */
export function demoUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//")) return url; // absolute URLs are not API calls of this app
  const path = url.startsWith("/") ? url : `/${url}`;
  return path === DEMO_PATH_PREFIX || path.startsWith(`${DEMO_PATH_PREFIX}/`) ? path : `${DEMO_PATH_PREFIX}${path}`;
}

export function saveDemoToken(token: string): void {
  try {
    sessionStorage.setItem(DEMO_TOKEN_KEY, token);
  } catch {
    // private mode: the session simply will not survive a reload
  }
}
export function readDemoToken(): string | null {
  try {
    return sessionStorage.getItem(DEMO_TOKEN_KEY);
  } catch {
    return null;
  }
}
export function clearDemoToken(): void {
  try {
    sessionStorage.removeItem(DEMO_TOKEN_KEY);
  } catch {
    // nothing to clear
  }
}

/** Navigation shown in a demo: only screens the demo service implements, so nothing in the menu leads to a dead page. */
export const DEMO_NAV_HREFS: Record<DemoRole, string[]> = {
  ADMIN: ["/dashboard", "/dashboard/reports", "/dashboard/users", "/dashboard/leads", "/dashboard/orders", "/dashboard/offers", "/dashboard/products"],
  MANAGER: ["/dashboard", "/dashboard/reports", "/dashboard/team", "/dashboard/salespersons", "/dashboard/leads", "/dashboard/orders", "/dashboard/offers", "/dashboard/products"],
  SALESPERSON: ["/dashboard", "/dashboard/leads", "/dashboard/orders", "/dashboard/offers"],
};

/** The one message shown wherever the demo has no data for a screen (the demo API answers the same words for an unimplemented endpoint). */
export const DEMO_UNAVAILABLE_MESSAGE = "This screen or feature is not available in the demo.";

/** Whether a dashboard URL is a screen the demo covers: the role's menu pages and their detail pages (a lead, an order, a salesperson). */
export function isDemoPathAvailable(pathname: string, role: DemoRole): boolean {
  const path = pathname.replace(/\/+$/, "") || "/dashboard";
  return DEMO_NAV_HREFS[role].some((href) => path === href || (href !== "/dashboard" && path.startsWith(`${href}/`)));
}
