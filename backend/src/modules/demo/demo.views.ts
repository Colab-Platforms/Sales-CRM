// Read models for the demo API: every response is built from the in-memory demo world, in the same shapes the real endpoints return, so the real screens render them
// unchanged. Pure functions; no database, no integration, no network.
import { DAY, HOUR, WORKING_STATUSES, demoId, istDay, istMidnight, type DemoCall, type DemoLead, type DemoOrder, type DemoRole, type DemoUser, type DemoWorld, type WorkingStatus } from "./demo.data.js";

export type Q = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown, fallback: number): number => (Number.isFinite(Number(v)) && v !== "" && v !== undefined ? Number(v) : fallback);
const list = (v: unknown): string[] => (typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);
const iso = (ms: number): string => new Date(ms).toISOString();
const money = (n: number): string => n.toFixed(2);
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface Viewer {
  role: DemoRole;
  user: DemoUser;
}

// ---- who sees what -------------------------------------------------------------------------------------------------------------------------------------------

export const userMap = (w: DemoWorld): Map<string, DemoUser> => new Map(w.users.map((u) => [u.id, u]));
const ref = (u: DemoUser) => ({ id: u.id, name: u.name, username: u.username });

/** Admin: everything. Manager: leads of the manager's own team. Telecaller: only the leads assigned to that telecaller. */
export function leadsFor(w: DemoWorld, v: Viewer): DemoLead[] {
  if (v.role === "ADMIN") return w.leads;
  if (v.role === "MANAGER") return w.leads.filter((l) => l.managerId === v.user.id);
  return w.leads.filter((l) => l.ownerId === v.user.id);
}
export const teamFor = (w: DemoWorld, v: Viewer): DemoUser[] =>
  v.role === "ADMIN" ? w.users.filter((u) => u.role === "SALESPERSON") : v.role === "MANAGER" ? w.users.filter((u) => u.role === "SALESPERSON" && u.managerId === v.user.id) : [v.user];
export function ordersFor(w: DemoWorld, v: Viewer): DemoOrder[] {
  const ids = new Set(leadsFor(w, v).map((l) => l.id));
  return w.orders.filter((o) => ids.has(o.leadId));
}

// ---- leads ---------------------------------------------------------------------------------------------------------------------------------------------------

const emptyCounts = (): Record<WorkingStatus, number> => Object.fromEntries(WORKING_STATUSES.map((s) => [s, 0])) as Record<WorkingStatus, number>;
const countByStatus = (leads: DemoLead[]) => {
  const c = emptyCounts();
  for (const l of leads) c[l.workingStatus]++;
  return c;
};

export function mapLead(w: DemoWorld, l: DemoLead) {
  const users = userMap(w);
  const owner = l.ownerId ? users.get(l.ownerId) : undefined;
  const manager = l.managerId ? users.get(l.managerId) : undefined;
  const source = w.sources.find((s) => s.id === l.sourceId) ?? null;
  return {
    id: l.id,
    leadNumber: l.leadNumber,
    firstName: l.firstName,
    lastName: l.lastName,
    mobile: l.mobile,
    email: l.email,
    requirement: l.requirement,
    location: l.location,
    workingStatus: l.workingStatus,
    priority: l.priority,
    createdAt: iso(l.createdAt),
    updatedAt: iso(l.updatedAt),
    source,
    owner: owner ? ref(owner) : null,
    assignedManager: manager ? ref(manager) : null,
    group: manager ? { id: demoId(10, manager.id.endsWith("2") ? 1 : 2), name: manager.id.endsWith("2") ? "Demo Team Alpha" : "Demo Team Beta" } : null,
    importBatch: null,
    calls: [],
    tasks: w.tasks.filter((t) => t.leadId === l.id && !t.done).slice(0, 1).map((t) => ({ id: t.id, type: t.type, scheduledAt: iso(t.scheduledAt) })),
    aiAgent: null,
    segments: [],
    customerClass: null,
    orderCount: w.orders.filter((o) => o.leadId === l.id).length,
  };
}

export function listLeads(w: DemoWorld, v: Viewer, q: Q) {
  let rows = leadsFor(w, v);
  const search = str(q.search)?.toLowerCase();
  if (search) rows = rows.filter((l) => `${l.firstName} ${l.lastName} ${l.leadNumber} ${l.mobile} ${l.email}`.toLowerCase().includes(search));
  const name = str(q.name)?.toLowerCase();
  if (name) rows = rows.filter((l) => `${l.firstName} ${l.lastName}`.toLowerCase().includes(name));
  const contact = str(q.contact)?.toLowerCase();
  if (contact) rows = rows.filter((l) => `${l.mobile} ${l.email}`.toLowerCase().includes(contact));
  if (str(q.workingStatus)) rows = rows.filter((l) => l.workingStatus === q.workingStatus);
  if (str(q.sourceId)) rows = rows.filter((l) => l.sourceId === q.sourceId);
  if (str(q.priority)) rows = rows.filter((l) => l.priority === q.priority);
  if (str(q.salespersonId)) rows = rows.filter((l) => (q.salespersonId === "NONE" ? !l.ownerId : l.ownerId === q.salespersonId));
  if (str(q.managerId)) rows = rows.filter((l) => (q.managerId === "NONE" ? !l.managerId : l.managerId === q.managerId));
  const assignment = str(q.assignment);
  if (assignment === "UNASSIGNED") rows = rows.filter((l) => !l.ownerId && !l.managerId);
  if (assignment === "ASSIGNED_TO_MANAGER") rows = rows.filter((l) => l.managerId && !l.ownerId);
  if (assignment === "ASSIGNED_TO_SALESPERSON") rows = rows.filter((l) => l.ownerId);
  if (str(q.createdFrom)) rows = rows.filter((l) => l.createdAt >= Date.parse(`${q.createdFrom}T00:00:00+05:30`));
  if (str(q.createdTo)) rows = rows.filter((l) => l.createdAt < Date.parse(`${q.createdTo}T00:00:00+05:30`) + DAY);
  if (q.bucket === "TODAY") rows = rows.filter((l) => l.createdAt >= istMidnight(w.builtAt));
  rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : -1));
  const limit = Math.min(Math.max(num(q.limit, 20), 1), 100);
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(num(q.page, 1), 1), totalPages);
  return { data: rows.slice((page - 1) * limit, page * limit).map((l) => mapLead(w, l)), pagination: { page, limit, total, totalPages } };
}

export const findLead = (w: DemoWorld, v: Viewer, id: string): DemoLead | undefined => leadsFor(w, v).find((l) => l.id === id);

export function bucketSummary(w: DemoWorld, v: Viewer) {
  const today = istMidnight(w.builtAt);
  return teamFor(w, v).map((u) => {
    const mine = w.leads.filter((l) => l.ownerId === u.id && l.createdAt >= today - 2 * DAY);
    const done = mine.filter((l) => l.workingStatus !== "NEW" && l.workingStatus !== "ASSIGNED").length;
    return { salespersonId: u.id, name: u.name, total: mine.length, done, remaining: mine.length - done, isEmpty: mine.length === 0 };
  });
}

export function leadCalls(w: DemoWorld, leadId: string) {
  const users = userMap(w);
  return w.calls
    .filter((c) => c.leadId === leadId)
    .sort((a, b) => b.at - a.at)
    .map((c: DemoCall) => ({
      id: c.id,
      provider: "demo",
      direction: "OUTBOUND",
      status: c.status,
      startedAt: iso(c.at),
      answeredAt: c.durationSeconds ? iso(c.at + 6000) : null,
      endedAt: iso(c.at + (c.durationSeconds + 6) * 1000),
      durationSeconds: c.durationSeconds || null,
      recording: null,
      transcript: null,
      agent: { id: c.agentId, name: users.get(c.agentId)?.name ?? "Demo Telecaller" },
      notes: c.notes,
      outcome: null,
    }));
}

export function leadAssignments(w: DemoWorld, l: DemoLead) {
  const users = userMap(w);
  const owner = l.ownerId ? users.get(l.ownerId) : undefined;
  const manager = l.managerId ? users.get(l.managerId) : undefined;
  if (!owner) return [];
  return [
    {
      id: demoId(11, Number(l.leadNumber.slice(-4))),
      assignmentType: "ROUND_ROBIN",
      assignedAt: iso(l.createdAt + 60_000),
      unassignedAt: null,
      isCurrent: true,
      user: { id: owner.id, name: owner.name, role: "SALESPERSON" },
      assignedBy: manager ? { id: manager.id, name: manager.name, role: "MANAGER" } : null,
      group: null,
    },
  ];
}

export function leadTimeline(w: DemoWorld, l: DemoLead, q: Q) {
  const users = userMap(w);
  const entries = [
    ...w.notes
      .filter((n) => n.leadId === l.id)
      .map((n) => ({
        id: n.id,
        type: n.type === "LEAD_CREATED" ? "LEAD_CREATED" : n.type === "LEAD_ASSIGNED" ? "ASSIGNMENT" : "TASK",
        title: n.title,
        description: n.description,
        occurredAt: iso(n.at),
        actor: users.get(n.actorId) ? { id: n.actorId, name: users.get(n.actorId)!.name } : null,
        order: null,
        source: "ACTIVITY" as const,
      })),
    ...w.calls
      .filter((c) => c.leadId === l.id)
      .map((c) => ({
        id: c.id,
        type: "CALL",
        title: c.status === "COMPLETED" ? `Call connected (${Math.round(c.durationSeconds / 60)} min)` : `Call not connected (${c.status.replace(/_/g, " ").toLowerCase()})`,
        description: c.notes,
        occurredAt: iso(c.at),
        actor: { id: c.agentId, name: users.get(c.agentId)?.name ?? "Demo Telecaller" },
        order: null,
        source: "RECORD" as const,
      })),
    ...w.orders
      .filter((o) => o.leadId === l.id)
      .map((o) => ({
        id: `${o.id}-created`,
        type: "ORDER_CREATED",
        title: `Order ${o.orderNumber} created`,
        description: null,
        occurredAt: iso(o.at),
        actor: o.sellerId ? { id: o.sellerId, name: users.get(o.sellerId)?.name ?? "" } : null,
        order: { id: o.id, orderNumber: o.orderNumber, externalNumber: null },
        source: "RECORD" as const,
      })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const pageSize = Math.min(Math.max(num(q.pageSize, 20), 1), 100);
  const page = Math.max(num(q.page, 1), 1);
  return { leadId: l.id, entries: entries.slice((page - 1) * pageSize, page * pageSize), pagination: { page, pageSize, totalItems: entries.length, totalPages: Math.max(1, Math.ceil(entries.length / pageSize)) } };
}

// ---- dashboards ----------------------------------------------------------------------------------------------------------------------------------------------

export function groupsFor(w: DemoWorld, v: Viewer) {
  const managers = w.users.filter((u) => u.role === "MANAGER");
  const all = managers.map((m, i) => ({
    id: demoId(10, i + 1),
    name: i === 0 ? "Demo Team Alpha" : "Demo Team Beta",
    description: "Fictional demo team",
    managerId: m.id,
    status: "ACTIVE",
    createdAt: iso(w.builtAt - 120 * DAY),
    updatedAt: iso(w.builtAt - 10 * DAY),
    members: w.users
      .filter((u) => u.role === "SALESPERSON" && u.managerId === m.id)
      .map((u) => ({ id: demoId(12, Number(u.id.slice(-2))), userId: u.id, isActive: true, joinedAt: iso(w.builtAt - 100 * DAY), user: { id: u.id, name: u.name, username: u.username, phone: u.phone, status: "ACTIVE" } })),
  }));
  return v.role === "MANAGER" ? all.filter((g) => g.managerId === v.user.id) : all;
}

export function dashboard(w: DemoWorld, v: Viewer) {
  const leads = leadsFor(w, v);
  const statusCounts = countByStatus(leads);
  if (v.role === "ADMIN") {
    return {
      role: "ADMIN",
      totalLeads: leads.length,
      totalGroups: 2,
      statusCounts,
      usersByRole: [
        { role: "ADMIN", count: w.users.filter((u) => u.role === "ADMIN").length },
        { role: "MANAGER", count: w.users.filter((u) => u.role === "MANAGER").length },
        { role: "SALESPERSON", count: w.users.filter((u) => u.role === "SALESPERSON").length },
      ],
    };
  }
  if (v.role === "MANAGER") {
    return {
      role: "MANAGER",
      groups: groupsFor(w, v).map((g) => ({ id: g.id, name: g.name, status: g.status })),
      totalLeads: leads.length,
      statusCounts,
      team: teamFor(w, v).map((u) => {
        const mine = leads.filter((l) => l.ownerId === u.id);
        return { id: u.id, name: u.name, username: u.username, totalLeads: mine.length, statusCounts: countByStatus(mine) };
      }),
    };
  }
  return {
    role: "SALESPERSON",
    totalLeads: leads.length,
    statusCounts,
    recentLeads: [...leads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8).map((l) => ({ id: l.id, leadNumber: l.leadNumber, firstName: l.firstName, lastName: l.lastName, workingStatus: l.workingStatus, priority: l.priority, updatedAt: iso(l.updatedAt) })),
  };
}

export function profile(w: DemoWorld, v: Viewer) {
  const base = { id: v.user.id, name: v.user.name, username: v.user.username, email: v.user.email, phone: v.user.phone, status: "ACTIVE", createdAt: iso(w.builtAt - 200 * DAY), lastLoginAt: iso(w.builtAt) };
  const total = leadsFor(w, v).length;
  const managers = w.users.filter((u) => u.role === "MANAGER");
  if (v.role === "ADMIN") return { ...base, role: "ADMIN", orgOverview: { totalManagers: managers.length, totalSalespersons: w.users.filter((u) => u.role === "SALESPERSON").length, totalGroups: 2, totalLeads: total } };
  if (v.role === "MANAGER") return { ...base, role: "MANAGER", groups: groupsFor(w, v).map((g) => ({ id: g.id, name: g.name, status: g.status, memberCount: g.members.length })), teamMemberCount: teamFor(w, v).length, stats: { totalLeads: total } };
  const manager = w.users.find((u) => u.id === v.user.managerId);
  return { ...base, role: "SALESPERSON", reportingManager: manager ? { id: manager.id, name: manager.name, username: manager.username, phone: manager.phone } : null, teams: [], stats: { totalLeads: total } };
}

// ---- tasks, people, sources ---------------------------------------------------------------------------------------------------------------------------------

export function followUps(w: DemoWorld, v: Viewer) {
  const leads = new Map(leadsFor(w, v).map((l) => [l.id, l]));
  return w.tasks
    .filter((t) => !t.done && leads.has(t.leadId) && (v.role !== "SALESPERSON" || t.userId === v.user.id))
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, 40)
    .map((t) => {
      const l = leads.get(t.leadId)!;
      return { id: t.id, type: t.type, title: t.type === "CALLBACK" ? "Call back" : "Follow up", description: t.description, scheduledAt: iso(t.scheduledAt), lead: { id: l.id, leadNumber: l.leadNumber, firstName: l.firstName, lastName: l.lastName, mobile: l.mobile } };
    });
}

export const sourcesList = (w: DemoWorld) =>
  w.sources.map((s) => ({ id: s.id, name: s.name, code: s.name.toLowerCase().replace(/\W+/g, "_"), description: "Fictional demo source", type: "WEBSITE", status: "ACTIVE", config: null, hasCredentials: false, externalAccountId: null, lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null, createdAt: iso(w.builtAt - 150 * DAY), updatedAt: iso(w.builtAt - 5 * DAY) }));

export function peopleLists(w: DemoWorld, v: Viewer) {
  const users = userMap(w);
  const spRows = w.users
    .filter((u) => u.role === "SALESPERSON" && (v.role !== "MANAGER" || u.managerId === v.user.id))
    .map((u) => ({ id: u.id, name: u.name, username: u.username, phone: u.phone, role: "SALESPERSON", status: "ACTIVE", reportingManager: u.managerId ? ref(users.get(u.managerId)!) : null }));
  return {
    managers: w.users.filter((u) => u.role === "MANAGER").map((u) => ({ id: u.id, name: u.name, username: u.username, phone: u.phone, role: "MANAGER", status: "ACTIVE" })),
    salespersons: spRows,
    mine: spRows.map((u) => {
      const g = groupsFor(w, v).find((x) => x.members.some((m) => m.userId === u.id));
      return { id: u.id, name: u.name, username: u.username, phone: u.phone, status: "ACTIVE", groupId: g?.id ?? null, groupName: g?.name ?? null };
    }),
    admins: w.users.filter((u) => u.role === "ADMIN").map((u) => ({ id: u.id, name: u.name, username: u.username, email: u.email, phone: u.phone, role: "ADMIN", status: "ACTIVE" })),
  };
}

export const callOutcomes = () =>
  [
    ["Interested", "INTERESTED", "INTERESTED", false], ["Not interested", "NOT_INTERESTED", "NOT_INTERESTED", false], ["Call back later", "CALL_BACK", "FOLLOW_UP", true], ["No answer", "NO_ANSWER", "NOT_CONNECTED", false],
  ].map(([name, code, category, requiresFollowup], i) => ({ id: demoId(13, i + 1), name, code, category, requiresFollowup, requiresNote: false }));

// ---- orders --------------------------------------------------------------------------------------------------------------------------------------------------

const fulfilmentOf = (o: DemoOrder) => (o.status === "DELIVERED" || o.status === "SHIPPED" ? "FULFILLED" : "UNFULFILLED");
const modeOf = (o: DemoOrder) => (o.method === "COD" ? "COD" : "PREPAID");

export function mapOrderRow(w: DemoWorld, o: DemoOrder) {
  const lead = w.leads.find((l) => l.id === o.leadId)!;
  const seller = o.sellerId ? w.users.find((u) => u.id === o.sellerId) : undefined;
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    source: o.source,
    currency: "INR",
    totalAmount: money(o.total),
    itemCount: 1,
    paymentStatus: o.paymentStatus,
    paymentMode: modeOf(o),
    externalNumber: null,
    createdAt: iso(o.at),
    customer: { leadId: lead.id, leadNumber: lead.leadNumber, name: `${lead.firstName} ${lead.lastName}` },
    salesperson: seller ? { id: seller.id, name: seller.name } : null,
    leadSource: w.sources.find((s) => s.id === lead.sourceId) ?? null,
    linkedInCrm: true,
    fulfillmentStatus: fulfilmentOf(o),
    hasTracking: o.status === "SHIPPED" || o.status === "DELIVERED",
    shippingMethod: "Standard",
    tags: seller ? [`Order Created by ${seller.name}`] : [],
  };
}

export function filterOrders(w: DemoWorld, v: Viewer, q: Q): DemoOrder[] {
  let rows = ordersFor(w, v);
  const search = str(q.search)?.toLowerCase();
  const leads = new Map(w.leads.map((l) => [l.id, l]));
  if (search) rows = rows.filter((o) => { const l = leads.get(o.leadId)!; return `${o.orderNumber} ${l.firstName} ${l.lastName} ${l.mobile} ${l.leadNumber}`.toLowerCase().includes(search); });
  const pick = (key: string, test: (o: DemoOrder, values: string[]) => boolean) => {
    const values = list(q[key]);
    if (values.length) rows = rows.filter((o) => test(o, values));
  };
  pick("status", (o, vals) => vals.includes(o.status));
  pick("paymentMode", (o, vals) => vals.includes(modeOf(o)));
  pick("paymentStatus", (o, vals) => vals.includes(o.paymentStatus));
  pick("source", (o, vals) => vals.includes(o.source));
  pick("salespersonId", (o, vals) => Boolean(o.sellerId && vals.includes(o.sellerId)));
  pick("fulfillment", (o, vals) => vals.includes(fulfilmentOf(o)));
  pick("tags", () => false);
  if (str(q.totalMin)) rows = rows.filter((o) => o.total >= Number(q.totalMin));
  if (str(q.totalMax)) rows = rows.filter((o) => o.total <= Number(q.totalMax));
  if (str(q.dateFrom)) rows = rows.filter((o) => o.at >= Date.parse(String(q.dateFrom)));
  if (str(q.dateTo)) rows = rows.filter((o) => o.at <= Date.parse(String(q.dateTo)));
  return [...rows].sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
}

export function listOrders(w: DemoWorld, v: Viewer, q: Q) {
  const rows = filterOrders(w, v, q);
  const first = Math.min(Math.max(num(q.first, 20), 1), 100);
  const start = Math.max(num(q.after, 0), 0);
  const end = Math.min(start + first, rows.length);
  return { items: rows.slice(start, end).map((o) => mapOrderRow(w, o)), pageInfo: { hasNextPage: end < rows.length, hasPreviousPage: start > 0, endCursor: end < rows.length ? String(end) : null } };
}

export function orderDetail(w: DemoWorld, v: Viewer, id: string) {
  const o = ordersFor(w, v).find((x) => x.id === id);
  if (!o) return null;
  const lead = w.leads.find((l) => l.id === o.leadId)!;
  const product = w.products.find((p) => p.id === o.productId)!;
  const seller = o.sellerId ? w.users.find((u) => u.id === o.sellerId) : undefined;
  const owner = lead.ownerId ? w.users.find((u) => u.id === lead.ownerId) : undefined;
  const cancelled = o.status === "CANCELLED";
  const paid = o.paymentStatus === "SUCCESS";
  const shipped = o.status === "SHIPPED" || o.status === "DELIVERED";
  return {
    id: o.id, orderNumber: o.orderNumber, status: o.status, source: o.source, currency: "INR",
    subtotal: money(o.total), discountAmount: "0.00", taxAmount: "0.00", shippingAmount: "0.00", totalAmount: money(o.total), discountReason: null, externalNumber: null,
    shippingAddress: { name: `${lead.firstName} ${lead.lastName}`, line1: "12 Demo Street (fictional)", city: lead.location, state: "Maharashtra", pincode: "000000", phone: lead.mobile },
    shippingPincode: "000000", parcelWeightKg: money(product.weightKg * o.quantity), cancelReason: cancelled ? "Demo cancellation" : null,
    shopifyCancellation: null, paymentLinkCancellation: null, shopifyPaymentSync: null, shiprocketSync: null, shiprocketCancellation: null, whatsappNotification: null,
    confirmedBy: seller ? { id: seller.id, name: seller.name } : null, createdByUser: seller ? { id: seller.id, name: seller.name } : null,
    createdAt: iso(o.at), placedAt: iso(o.at), confirmedAt: cancelled ? null : iso(o.at + 10 * 60_000), cancelledAt: cancelled ? iso(o.at + HOUR) : null,
    paymentStatus: o.paymentStatus, paymentMode: modeOf(o), paidAmount: money(paid ? o.total : 0), refundedAmount: "0.00", outstandingAmount: money(paid || cancelled ? 0 : o.total),
    reconciliationStatus: paid ? "PAID" : o.paymentStatus === "FAILED" ? "FAILED" : "PENDING",
    customer: { leadId: lead.id, leadNumber: lead.leadNumber, name: `${lead.firstName} ${lead.lastName}`, mobile: lead.mobile, email: lead.email, abandonmentId: null },
    leadSource: w.sources.find((s) => s.id === lead.sourceId) ?? null,
    bookedBy: seller ? ref(seller) : null,
    leadOwner: owner ? { id: owner.id, name: owner.name } : null,
    items: [{ id: demoId(14, Number(o.id.slice(-4))), productId: product.id, variantId: null, productName: product.name, variantName: null, sku: product.sku, quantity: o.quantity, unitPrice: money(product.price), discountAmount: "0.00", taxAmount: "0.00", totalPrice: money(o.total), itemType: "CATALOG" }],
    payments: [{ id: demoId(15, Number(o.id.slice(-4))), status: o.paymentStatus, method: o.method, amount: money(o.total), currency: "INR", provider: null, providerPaymentId: null, transactionReference: null, paidAt: paid ? iso(o.at + 20 * 60_000) : null, failedAt: o.paymentStatus === "FAILED" ? iso(o.at + HOUR) : null, refundedAt: null, refundedAmount: null, failureReason: null, createdAt: iso(o.at), source: null, paymentUrl: null, paymentExpiresAt: null }],
    shipments: shipped ? [{ id: demoId(16, Number(o.id.slice(-4))), status: o.status === "DELIVERED" ? "DELIVERED" : "IN_TRANSIT", courier: "Demo Courier", trackingNumber: `DEMO${o.id.slice(-6)}`, trackingUrl: null, shippedAt: iso(o.at + DAY), expectedDeliveryAt: iso(o.at + 4 * DAY), deliveredAt: o.status === "DELIVERED" ? iso(o.at + 3 * DAY) : null, returnedAt: null, createdAt: iso(o.at + DAY) }] : [],
    tracking: { state: "NOT_CREATED", headline: shipped ? "Shipped (demo data)" : "Order confirmed (demo data)", shipments: [], orderEvents: [] },
    shopifyLive: null,
  };
}

export function orderStatusHistory(w: DemoWorld, v: Viewer, id: string) {
  const o = ordersFor(w, v).find((x) => x.id === id);
  if (!o) return null;
  return { orderId: o.id, orderNumber: o.orderNumber, currentStatus: o.status, entries: [{ id: `${o.id}-h1`, event: "ORDER_CREATED", title: "Order created", description: null, occurredAt: iso(o.at), actor: null, source: "ORDER_RECORD" }] };
}

export const orderFilterOptions = (w: DemoWorld, v: Viewer) => ({ salespeople: teamFor(w, v).map((u) => ({ id: u.id, name: u.name })), leadSources: w.sources });

// ---- products & marketing ------------------------------------------------------------------------------------------------------------------------------------

export function listProducts(w: DemoWorld, q: Q) {
  const pageSize = Math.min(Math.max(num(q.pageSize, 20), 1), 100);
  const page = Math.max(num(q.page, 1), 1);
  const search = str(q.search)?.toLowerCase();
  const rows = w.products.filter((p) => !search || `${p.name} ${p.sku}`.toLowerCase().includes(search));
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize).map((p) => ({ id: p.id, name: p.name, sku: p.sku, basePrice: money(p.price), weightKg: money(p.weightKg), dimensionsCm: null, variants: [] })),
    pagination: { page, pageSize, totalItems: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / pageSize)) },
  };
}

export const activeOffers = (w: DemoWorld) => ({
  fetchedAt: iso(w.builtAt),
  offers: [
    { id: demoId(17, 1), couponCode: "DEMO10", discountType: "percentage", discountValue: 10, automaticDiscount: false, startTime: iso(w.builtAt - 10 * DAY), endTime: iso(w.builtAt + 20 * DAY), active: true, minCartTotal: 499, minQtyProduct: null, productFilter: null, expiringSoon: false },
    { id: demoId(17, 2), couponCode: "WELCOME150", discountType: "flat", discountValue: 150, automaticDiscount: false, startTime: iso(w.builtAt - 5 * DAY), endTime: iso(w.builtAt + 36 * HOUR), active: true, minCartTotal: 999, minQtyProduct: null, productFilter: null, expiringSoon: true },
    { id: demoId(17, 3), couponCode: null, discountType: "percentage", discountValue: 5, automaticDiscount: true, startTime: iso(w.builtAt - 30 * DAY), endTime: null, active: true, minCartTotal: null, minQtyProduct: 2, productFilter: null, expiringSoon: false },
  ],
});

// ---- abandoned checkouts (summary cards only) ---------------------------------------------------------------------------------------------------------------

export function abandonmentSummaries(w: DemoWorld, v: Viewer) {
  const today = istMidnight(w.builtAt);
  const mine = new Set(leadsFor(w, v).map((l) => l.id));
  const owners = new Map(w.leads.map((l) => [l.id, l.ownerId]));
  const rows = w.abandonments.filter((a) => mine.has(a.leadId));
  const count = (filter: (a: { at: number }) => boolean, user?: string) => rows.filter((a) => filter(a) && (!user || owners.get(a.leadId) === user)).length;
  const isToday = (a: { at: number }) => a.at >= today;
  const isYesterday = (a: { at: number }) => a.at < today && a.at >= today - DAY;
  return {
    mySummary: { timezone: "Asia/Kolkata", totalAssigned: count(() => true, v.user.id), today: count(isToday, v.user.id), yesterday: count(isYesterday, v.user.id), all: count(() => true, v.user.id), newlyAssignedToday: count(isToday, v.user.id) },
    distribution: (range: string) => ({
      range,
      timezone: "Asia/Kolkata",
      summary: { total: rows.length, assigned: rows.filter((a) => owners.get(a.leadId)).length, unassigned: rows.filter((a) => !owners.get(a.leadId)).length, telecallersWithLeads: teamFor(w, v).filter((u) => rows.some((a) => owners.get(a.leadId) === u.id)).length, todayTotal: count(isToday), yesterdayTotal: count(isYesterday), unassignedAllTime: rows.filter((a) => !owners.get(a.leadId)).length },
      telecallers: teamFor(w, v).map((u) => ({ userId: u.id, name: u.name, totalAssigned: count(() => true, u.id), inPeriod: count(range === "today" ? isToday : range === "yesterday" ? isYesterday : () => true, u.id), todayAbandoned: count(isToday, u.id), yesterdayAbandoned: count(isYesterday, u.id), assignedToday: count(isToday, u.id), assignedInPeriod: count(isToday, u.id) })),
    }),
  };
}

// ---- analytics (Manager dashboard and Reports) --------------------------------------------------------------------------------------------------------------

const SOLD = new Set(["CONFIRMED", "PROCESSING", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]);
const callBucket = (c: DemoCall): "connected" | "notConnected" | "failed" => (c.status === "COMPLETED" ? "connected" : c.status === "FAILED" ? "failed" : "notConnected");

function callCounts(calls: DemoCall[]) {
  return {
    calls: calls.length,
    connected: calls.filter((c) => callBucket(c) === "connected").length,
    notConnected: calls.filter((c) => callBucket(c) === "notConnected").length,
    failed: calls.filter((c) => callBucket(c) === "failed").length,
    uniqueLeads: new Set(calls.map((c) => c.leadId)).size,
    talkTimeSec: calls.reduce((s, c) => s + c.durationSeconds, 0),
  };
}
function salesCounts(orders: DemoOrder[]) {
  const sum = (xs: DemoOrder[]) => round2(xs.reduce((s, o) => s + o.total, 0));
  const collected = (xs: DemoOrder[]) => round2(xs.filter((o) => o.paymentStatus === "SUCCESS").reduce((s, o) => s + o.total, 0));
  const cod = orders.filter((o) => o.method === "COD");
  const pre = orders.filter((o) => o.method !== "COD");
  const revenue = sum(orders);
  return { orders: orders.length, revenue, assistedOrders: 0, assistedRevenue: 0, collected: collected(orders), aov: orders.length ? round2(revenue / orders.length) : 0, codOrders: cod.length, codRevenue: sum(cod), codCollected: collected(cod), prepaidOrders: pre.length, prepaidRevenue: sum(pre), prepaidCollected: collected(pre) };
}

export function analytics(w: DemoWorld, v: Viewer, q: Q, only?: string) {
  const today = istDay(w.builtAt);
  let from = str(q.from) ?? today;
  let to = str(q.to) ?? today;
  if (from > to) [from, to] = [to, from];
  const start = Date.parse(`${from}T00:00:00+05:30`);
  const end = Date.parse(`${to}T00:00:00+05:30`) + DAY;
  const days = Math.max(1, Math.round((end - start) / DAY));
  const prevStart = start - days * DAY;
  const inRange = (at: number) => at >= start && at < end;

  const team = teamFor(w, v).filter((u) => !only || u.id === only);
  const teamIds = new Set(team.map((u) => u.id));
  const sourceId = str(q.sourceId);
  const callFilter = str(q.callStatus) ?? "ALL";
  const leadFilter = str(q.leadStatus) ?? "ALL";
  const payFilter = str(q.paymentMode) ?? "ALL";
  const orderFilter = str(q.orderStatus) ?? "ALL";
  const scoped = leadsFor(w, v);
  const scopedIds = new Set(scoped.map((l) => l.id));

  const calls = w.calls.filter((c) => scopedIds.has(c.leadId) && teamIds.has(c.agentId) && inRange(c.at) && (callFilter === "ALL" || (callFilter === "CONNECTED" ? callBucket(c) === "connected" : callFilter === "FAILED" ? callBucket(c) === "failed" : callBucket(c) === "notConnected")));
  const orders = w.orders.filter((o) => scopedIds.has(o.leadId) && o.sellerId && teamIds.has(o.sellerId) && inRange(o.at) && SOLD.has(o.status) && (orderFilter === "ALL" || o.status === orderFilter) && (payFilter === "ALL" || modeOf(o) === payFilter));
  const prevOrders = w.orders.filter((o) => scopedIds.has(o.leadId) && o.sellerId && teamIds.has(o.sellerId) && o.at >= prevStart && o.at < start && SOLD.has(o.status));

  const leadMatches = (l: DemoLead) => (!sourceId || l.sourceId === sourceId) && (leadFilter === "ALL" || (leadFilter === "NOT_CONTACTED" ? l.workingStatus === "NEW" || l.workingStatus === "ASSIGNED" : leadFilter === "CONTACTED" ? l.workingStatus !== "NEW" && l.workingStatus !== "ASSIGNED" : leadFilter === "INTERESTED" ? l.workingStatus === "INTERESTED" : l.workingStatus === "CONVERTED"));
  const received = scoped.filter((l) => inRange(l.createdAt) && (!sourceId || l.sourceId === sourceId));
  const receivedPrev = scoped.filter((l) => l.createdAt >= prevStart && l.createdAt < start && (!sourceId || l.sourceId === sourceId));
  const assigned = received.filter((l) => l.ownerId && teamIds.has(l.ownerId));
  const base = assigned.filter(leadMatches);

  const perPerson = (u: DemoUser) => {
    const c = callCounts(calls.filter((x) => x.agentId === u.id));
    const mine = scoped.filter((l) => l.ownerId === u.id && leadMatches(l));
    return {
      id: u.id, name: u.name, username: u.username, email: u.email, accountStatus: "ACTIVE", workStatus: Math.abs(u.id.charCodeAt(u.id.length - 1)) % 4 === 0 ? "ON_BREAK" : "ACTIVE",
      ...c, ...salesCounts(orders.filter((o) => o.sellerId === u.id)),
      leads: mine.length,
      contacted: mine.filter((l) => l.workingStatus !== "NEW" && l.workingStatus !== "ASSIGNED").length,
      interested: mine.filter((l) => l.workingStatus === "INTERESTED").length,
      converted: mine.filter((l) => l.workingStatus === "CONVERTED").length,
      productiveMs: (c.talkTimeSec + c.calls * 90) * 1000,
    };
  };
  const people = team.map(perPerson);

  const dayKeys: string[] = [];
  for (let d = 0; d < Math.min(days, 92); d++) dayKeys.push(istDay(start + d * DAY));
  const daily = dayKeys.map((date) => {
    const dc = calls.filter((c) => istDay(c.at) === date);
    const dor = orders.filter((o) => istDay(o.at) === date);
    const dl = scoped.filter((l) => istDay(l.updatedAt) === date);
    const bySalesperson = Object.fromEntries(team.map((u) => {
      const uc = callCounts(dc.filter((c) => c.agentId === u.id));
      const ul = dl.filter((l) => l.ownerId === u.id);
      return [u.id, { ...uc, ...salesCounts(dor.filter((o) => o.sellerId === u.id)), productiveMs: (uc.talkTimeSec + uc.calls * 90) * 1000, interested: ul.filter((l) => l.workingStatus === "INTERESTED").length, converted: ul.filter((l) => l.workingStatus === "CONVERTED").length }];
    }));
    const cc = callCounts(dc);
    return { date, ...cc, ...salesCounts(dor), productiveMs: (cc.talkTimeSec + cc.calls * 90) * 1000, interested: dl.filter((l) => l.workingStatus === "INTERESTED").length, converted: dl.filter((l) => l.workingStatus === "CONVERTED").length, bySalesperson };
  });

  const callTotals = callCounts(calls);
  const productRows = w.products
    .map((p) => {
      const rows = orders.filter((o) => o.productId === p.id);
      const bySeller = new Map<string, number>();
      for (const o of rows) bySeller.set(o.sellerId!, (bySeller.get(o.sellerId!) ?? 0) + o.quantity);
      const top = [...bySeller].sort((a, b) => b[1] - a[1])[0];
      const topUser = top ? w.users.find((u) => u.id === top[0]) : undefined;
      return { key: p.id, name: p.name, sku: p.sku, orders: rows.length, units: rows.reduce((s, o) => s + o.quantity, 0), revenue: round2(rows.reduce((s, o) => s + o.total, 0)), codOrders: rows.filter((o) => o.method === "COD").length, prepaidOrders: rows.filter((o) => o.method !== "COD").length, sellers: bySeller.size, topSalesperson: topUser && top ? { id: topUser.id, name: topUser.name, units: top[1] } : null };
    })
    .filter((p) => p.orders > 0)
    .sort((a, b) => b.revenue - a.revenue);

  const overview = {
    range: { from, to, days, tzOffsetMinutes: 330 },
    targets: { conversionRatePercent: 20, productiveMsPerDay: 4 * HOUR },
    team: team.map((u) => ({ id: u.id, name: u.name, username: u.username })),
    sources: w.sources,
    kpis: {
      ...salesCounts(orders),
      receivedLeads: received.length, previousReceivedLeads: receivedPrev.length, assignedLeads: assigned.length, previousAssignedLeads: receivedPrev.filter((l) => l.ownerId).length, unassignedLeads: received.length - assigned.length,
      totalLeads: base.length, previousTotalLeads: receivedPrev.filter((l) => l.ownerId).length,
      notContacted: base.filter((l) => l.workingStatus === "NEW" || l.workingStatus === "ASSIGNED").length,
      contacted: base.filter((l) => l.workingStatus !== "NEW" && l.workingStatus !== "ASSIGNED").length,
      interested: base.filter((l) => l.workingStatus === "INTERESTED").length,
      converted: base.filter((l) => l.workingStatus === "CONVERTED").length,
      callsMade: callTotals.calls, connectedCalls: callTotals.connected, notConnectedCalls: callTotals.notConnected, failedCalls: callTotals.failed, uniqueLeadsContacted: callTotals.uniqueLeads, talkTimeSec: callTotals.talkTimeSec,
      productiveMs: people.reduce((s, p) => s + p.productiveMs, 0),
      previousOrders: prevOrders.length, previousRevenue: round2(prevOrders.reduce((s, o) => s + o.total, 0)),
    },
    salespeople: people,
    products: productRows,
    daily,
  };
  if (!only) return overview;
  const person = people[0] ?? perPerson(w.users.find((u) => u.id === only)!);
  const users = userMap(w);
  const recent = [
    ...w.calls.filter((c) => c.agentId === only && inRange(c.at)).map((c) => ({ id: c.id, at: iso(c.at), kind: "CALL" as const, title: c.status === "COMPLETED" ? "Connected call" : "Call not connected", detail: c.notes, durationSec: c.durationSeconds || null, leadId: c.leadId })),
    ...w.notes.filter((n) => n.actorId === only && n.type === "NOTE" && inRange(n.at)).map((n) => ({ id: n.id, at: iso(n.at), kind: "ACTIVITY" as const, title: n.title, detail: n.description, durationSec: null, leadId: n.leadId })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 25);
  void users;
  return { ...overview, salesperson: person, recentActivity: recent };
}

export const WORKING_STATUS_SET = new Set<string>(WORKING_STATUSES);
