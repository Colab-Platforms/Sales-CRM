// Per-user module access, the app side. The server decides who is restricted (backend userModuleAccess.ts) and tells the app in the signed-in user's `blockedModules`; the app uses it to
// leave those modules out of the sidebar and to turn away their URLs. The server refuses the same modules' APIs on its own, so this is a convenience, never the protection.

/** Module key -> the page path it owns (its sub-pages included). */
export const MODULE_PATHS: Record<string, string> = {
  offers: "/dashboard/offers",
  "product-weights": "/dashboard/products",
  reconciliation: "/dashboard/reconciliation",
  shiprocket: "/dashboard/shiprocket",
  "performance-matrix": "/dashboard/performance-matrix",
  "report-automation": "/dashboard/report-automation",
  "audit-trail": "/dashboard/audit",
};

const owns = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** True when `pathname` belongs to a module this user may not use. */
export function isPathBlocked(pathname: string, blocked: readonly string[] | undefined): boolean {
  if (!blocked || blocked.length === 0) return false;
  return blocked.some((key) => MODULE_PATHS[key] && owns(pathname, MODULE_PATHS[key]!));
}

interface NavLike {
  href?: string;
  children?: NavLike[];
}
interface SectionLike<I extends NavLike> {
  label: string;
  items: I[];
}

/**
 * The sidebar without the user's blocked modules. A group that loses every child, and a section that loses every item, disappear with them - so no empty heading or
 * empty collapsible is left behind, and the spacing closes up by itself (it is just the next item or section in the list).
 */
export function filterNavSections<I extends NavLike, S extends SectionLike<I>>(sections: S[], blocked: readonly string[] | undefined): S[] {
  if (!blocked || blocked.length === 0) return sections;
  const keep = (item: I): I | null => {
    if (item.children) {
      const children = item.children.filter((c) => !(c.href && isPathBlocked(c.href, blocked)));
      return children.length > 0 ? ({ ...item, children } as I) : null;
    }
    return item.href && isPathBlocked(item.href, blocked) ? null : item;
  };
  return sections.map((s) => ({ ...s, items: s.items.map(keep).filter((i): i is I => i !== null) })).filter((s) => s.items.length > 0);
}
