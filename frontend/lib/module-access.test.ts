// Run with: ../backend/node_modules/.bin/tsx --test lib/module-access.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NAV_BY_ROLE } from "../components/app-sidebar";
import { MODULE_PATHS, filterNavSections, isPathBlocked } from "./module-access";

const ALL = Object.keys(MODULE_PATHS);
const titles = (sections: { items: { title: string; children?: { title: string }[] }[] }[]) => sections.flatMap((s) => s.items.flatMap((i) => [i.title, ...(i.children ?? []).map((c) => c.title)]));
const hrefs = (sections: { items: { href?: string; children?: { href?: string }[] }[] }[]) => sections.flatMap((s) => s.items.flatMap((i) => [i.href, ...(i.children ?? []).map((c) => c.href)])).filter(Boolean);

describe("per-user module access (sidebar)", () => {
  const manager = filterNavSections(NAV_BY_ROLE.MANAGER, ALL);

  it("removes exactly the seven modules from the manager's sidebar", () => {
    const left = titles(manager);
    for (const gone of ["Offers", "Product Weights", "Reconciliation", "Shiprocket", "Performance Matrix", "WhatsApp Report Automation", "Audit Trail"]) assert.ok(!left.includes(gone), gone);
    const before = titles(NAV_BY_ROLE.MANAGER);
    assert.equal(before.length - left.length, 7);
  });

  it("keeps every other module, in the same order", () => {
    const kept = titles(NAV_BY_ROLE.MANAGER).filter((t) => !["Offers", "Product Weights", "Reconciliation", "Shiprocket", "Performance Matrix", "WhatsApp Report Automation", "Audit Trail"].includes(t));
    assert.deepEqual(titles(manager), kept);
    for (const t of ["Dashboard", "Team", "Salespersons", "Leads", "Orders", "Orders Dashboard", "Refund Approvals", "Abandoned Leads", "Call Recordings", "Reports", "Virtual Numbers", "Support Tickets", "WhatsApp", "WhatsApp Templates", "WhatsApp Campaigns"]) assert.ok(titles(manager).includes(t), t);
  });

  it("leaves no empty section heading or empty group", () => {
    for (const s of manager) assert.ok(s.items.length > 0, s.label);
    // a section whose every item is blocked disappears entirely
    const gone = filterNavSections([{ label: "Only audit", items: [{ title: "Audit Trail", href: "/dashboard/audit" }] }, { label: "Kept", items: [{ title: "Leads", href: "/dashboard/leads" }] }], ALL);
    assert.deepEqual(gone.map((s) => s.label), ["Kept"]);
    // a group that loses every child goes too
    const group = filterNavSections([{ label: "G", items: [{ title: "Grp", children: [{ title: "Audit", href: "/dashboard/audit" }] }, { title: "Leads", href: "/dashboard/leads" }] }], ALL);
    assert.deepEqual(titles(group as never), ["Leads"]);
  });

  it("does not touch anyone without restrictions", () => {
    assert.equal(filterNavSections(NAV_BY_ROLE.MANAGER, undefined), NAV_BY_ROLE.MANAGER);
    assert.equal(filterNavSections(NAV_BY_ROLE.ADMIN, []), NAV_BY_ROLE.ADMIN);
    assert.ok(hrefs(NAV_BY_ROLE.ADMIN as never).includes("/dashboard/audit"));
  });

  it("the manager's Dashboard is still first, and the landing route is unchanged", () => {
    assert.equal(manager[0]!.items[0]!.href, "/dashboard");
  });
});

describe("per-user module access (URLs)", () => {
  it("turns away a blocked module's page and its sub-pages only", () => {
    assert.ok(isPathBlocked("/dashboard/audit", ALL));
    assert.ok(isPathBlocked("/dashboard/audit/anything", ALL));
    assert.ok(isPathBlocked("/dashboard/performance-matrix", ["performance-matrix"]));
    assert.ok(isPathBlocked("/dashboard/products", ["product-weights"]));
    assert.ok(!isPathBlocked("/dashboard/audit", ["offers"])); // a different module being blocked does not block this one
    for (const ok of ["/dashboard", "/dashboard/orders", "/dashboard/leads", "/dashboard/abandoned-leads", "/dashboard/abandoned-leads/call-recordings", "/dashboard/auditor", "/dashboard/whatsapp/templates"]) assert.ok(!isPathBlocked(ok, ALL), ok);
    assert.ok(!isPathBlocked("/dashboard/audit", undefined));
  });
});
