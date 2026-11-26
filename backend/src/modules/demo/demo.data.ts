// The DEMO world: entirely made-up records, generated in memory. This module (like everything in modules/demo) must never import the database, the Prisma
// client, or any integration - demo.isolation.test.ts walks the imports and fails the build if it does.
//
// Everything is fictional on purpose: surnames are "Sample"/"Demo"/"Example"..., e-mail uses the reserved example.com domain, and phone numbers start
// +91 00000, which no Indian mobile can (they start 6-9), so nothing here can ever reach a real person.

export type DemoRole = "ADMIN" | "MANAGER" | "SALESPERSON";
export const DEMO_ROLES: DemoRole[] = ["ADMIN", "MANAGER", "SALESPERSON"];

export type WorkingStatus = "NEW" | "ASSIGNED" | "RINGING" | "BUSY" | "CALL_BACK" | "FOLLOW_UP" | "SWITCHED_OFF" | "DND" | "NOT_REACHABLE" | "INTERESTED" | "NOT_INTERESTED" | "CONVERTED";
export const WORKING_STATUSES: WorkingStatus[] = ["NEW", "ASSIGNED", "RINGING", "BUSY", "CALL_BACK", "FOLLOW_UP", "SWITCHED_OFF", "DND", "NOT_REACHABLE", "INTERESTED", "NOT_INTERESTED", "CONVERTED"];

export interface DemoUser {
  id: string;
  name: string;
  username: string;
  email: string;
  phone: string;
  role: DemoRole;
  managerId: string | null;
}
export interface DemoLead {
  id: string;
  leadNumber: string;
  firstName: string;
  lastName: string;
  mobile: string;
  email: string;
  location: string;
  requirement: string;
  sourceId: string;
  workingStatus: WorkingStatus;
  priority: "LOW" | "MEDIUM" | "HIGH";
  ownerId: string | null;
  managerId: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface DemoCall {
  id: string;
  leadId: string;
  agentId: string;
  status: "COMPLETED" | "NO_ANSWER" | "BUSY" | "NOT_REACHABLE" | "FAILED";
  at: number;
  durationSeconds: number;
  notes: string | null;
}
export interface DemoNote {
  id: string;
  leadId: string;
  actorId: string;
  at: number;
  title: string;
  description: string | null;
  type: "NOTE" | "STATUS_CHANGE" | "LEAD_ASSIGNED" | "LEAD_CREATED";
}
export interface DemoTask {
  id: string;
  leadId: string;
  userId: string;
  type: "CALLBACK" | "FOLLOW_UP";
  description: string | null;
  scheduledAt: number;
  done: boolean;
}
export interface DemoProduct {
  id: string;
  name: string;
  sku: string;
  price: number;
  weightKg: number;
}
export interface DemoOrder {
  id: string;
  orderNumber: string;
  leadId: string;
  sellerId: string | null;
  source: "SALESPERSON" | "SHOPIFY" | "WEBSITE";
  status: "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "CANCELLED" | "PENDING_PAYMENT";
  method: "COD" | "UPI";
  paymentStatus: "SUCCESS" | "PENDING" | "FAILED";
  productId: string;
  quantity: number;
  total: number;
  at: number;
}
export interface DemoAbandonment {
  id: string;
  leadId: string;
  at: number;
}
export interface DemoWorld {
  builtAt: number;
  users: DemoUser[];
  sources: { id: string; name: string }[];
  products: DemoProduct[];
  leads: DemoLead[];
  calls: DemoCall[];
  notes: DemoNote[];
  tasks: DemoTask[];
  orders: DemoOrder[];
  abandonments: DemoAbandonment[];
}

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const IST_OFFSET = 330 * 60_000;
export const istMidnight = (at: number): number => Math.floor((at + IST_OFFSET) / DAY) * DAY - IST_OFFSET;
export const istDay = (at: number): string => new Date(at + IST_OFFSET).toISOString().slice(0, 10);

/** A stable, well-formed UUID for demo record n of a kind (the screens validate ids as UUIDs). */
export const demoId = (kind: number, n: number): string => `de300000-${String(kind).padStart(4, "0")}-4000-8000-${String(n).padStart(12, "0")}`;
export const demoPhone = (n: number): string => `+9100000${String(n).padStart(5, "0")}`;

const FIRST = ["Aarav", "Diya", "Kabir", "Isha", "Vivaan", "Anaya", "Reyansh", "Myra", "Arjun", "Saanvi", "Advik", "Kiara", "Rohan", "Tara", "Neel", "Meher", "Yash", "Pari", "Kunal", "Riya"];
const LAST = ["Sample", "Demo", "Example", "Specimen", "Mockwala", "Testkar", "Placeholder", "Fictional"];
const CITIES = ["Pune", "Mumbai", "Nashik", "Nagpur", "Indore", "Surat", "Jaipur", "Lucknow"];
const NEEDS = ["Asked about the immunity pack", "Wants a sleep support routine", "Comparing protein options", "Interested in a monthly plan", "Needs digestion support", "Enquired after an advertisement"];
const NOTE_TEXT = ["Shared the product benefits; wants to think it over", "Asked for the price of the two-month pack", "Prefers cash on delivery", "Requested a call after office hours", "Asked about ingredients and dosage", "Happy with the sample details; likely to order"];

export function buildDemoWorld(now: number = Date.now()): DemoWorld {
  // A small seeded generator: every demo session sees the same realistic shape.
  let seed = 20260101;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const weighted = <T>(entries: [T, number][]): T => {
    let roll = rand() * entries.reduce((s, [, w]) => s + w, 0);
    for (const [value, w] of entries) if ((roll -= w) < 0) return value;
    return entries[0]![0];
  };
  const midnight = istMidnight(now);

  const person = (n: number, name: string, role: DemoRole, managerId: string | null): DemoUser => {
    const slug = name.toLowerCase().replace(/[^a-z]+/g, ".");
    return { id: demoId(1, n), name, username: `demo.${slug}`, email: `${slug}@example.com`, phone: demoPhone(n), role, managerId };
  };
  const admin = person(1, "Anika Demo", "ADMIN", null);
  const managers = [person(2, "Meera Sample", "MANAGER", null), person(3, "Rahul Example", "MANAGER", null)];
  const telecallers = ["Priya Demo", "Sameer Sample", "Neha Example", "Imran Specimen", "Kavya Mockwala", "Dev Testkar", "Zoya Placeholder"].map((name, i) => person(10 + i, name, "SALESPERSON", managers[i < 4 ? 0 : 1]!.id));
  const users = [admin, ...managers, ...telecallers];

  const sources = ["Website", "Meta Ads", "Google Ads", "WhatsApp Enquiry", "Referral"].map((name, i) => ({ id: demoId(2, i + 1), name }));
  const products: DemoProduct[] = (
    [["Demo Immunity Blend", 699, 0.25], ["Demo Sleep Support", 549, 0.18], ["Demo Plant Protein", 1299, 1.0], ["Demo Digestive Tonic", 449, 0.55], ["Demo Daily Multivitamin", 399, 0.12], ["Demo Joint Care Oil", 349, 0.22], ["Demo Herbal Tea Box", 299, 0.3], ["Demo Wellness Combo", 1799, 1.4]] as const
  ).map(([name, price, weightKg], i) => ({ id: demoId(3, i + 1), name, sku: `DEMO-${String(i + 1).padStart(3, "0")}`, price, weightKg }));

  const leads: DemoLead[] = [];
  const calls: DemoCall[] = [];
  const notes: DemoNote[] = [];
  const tasks: DemoTask[] = [];
  const orders: DemoOrder[] = [];
  const abandonments: DemoAbandonment[] = [];

  for (let n = 1; n <= 420; n++) {
    // denser in recent days, so "today" and "this week" are populated
    const age = n <= 24 ? rand() * Math.max(now - midnight, HOUR) : n <= 60 ? now - midnight + rand() * DAY : Math.pow(rand(), 1.4) * 75 * DAY;
    const createdAt = Math.round(now - age - 60_000);
    // the first telecaller (the demo's Telecaller persona) gets a slightly bigger book
    const owner = rand() < 0.12 ? null : rand() < 0.1 ? telecallers[0]! : pick(telecallers);
    const managerId = owner ? owner.managerId : rand() < 0.5 ? pick(managers).id : null;
    const status: WorkingStatus = !owner
      ? "NEW"
      : weighted<WorkingStatus>([["ASSIGNED", 12], ["RINGING", 8], ["BUSY", 5], ["CALL_BACK", 9], ["FOLLOW_UP", 12], ["SWITCHED_OFF", 4], ["DND", 2], ["NOT_REACHABLE", 5], ["INTERESTED", 15], ["NOT_INTERESTED", 10], ["CONVERTED", 18]]);
    const lead: DemoLead = {
      id: demoId(4, n),
      leadNumber: `DEMO-L-${String(n).padStart(4, "0")}`,
      firstName: pick(FIRST),
      lastName: pick(LAST),
      mobile: demoPhone(1000 + n),
      email: `demo.customer${n}@example.com`,
      location: pick(CITIES),
      requirement: pick(NEEDS),
      sourceId: pick(sources).id,
      workingStatus: status,
      priority: weighted([["LOW", 3], ["MEDIUM", 5], ["HIGH", 2]]),
      ownerId: owner?.id ?? null,
      managerId,
      createdAt,
      updatedAt: createdAt,
    };
    leads.push(lead);
    notes.push({ id: demoId(6, notes.length + 1), leadId: lead.id, actorId: admin.id, at: createdAt, title: "Lead received", description: null, type: "LEAD_CREATED" });
    if (!owner) continue;
    const later = (fraction: number) => Math.round(createdAt + (now - createdAt) * fraction);
    notes.push({ id: demoId(6, notes.length + 1), leadId: lead.id, actorId: managerId ?? admin.id, at: later(0.02), title: `Assigned to ${owner.name}`, description: null, type: "LEAD_ASSIGNED" });
    if (status === "ASSIGNED") continue;

    const attempts = int(1, status === "CONVERTED" || status === "INTERESTED" ? 4 : 3);
    for (let k = 0; k < attempts; k++) {
      const last = k === attempts - 1;
      const connected = last ? ["CONVERTED", "INTERESTED", "FOLLOW_UP", "CALL_BACK", "NOT_INTERESTED", "DND"].includes(status) : rand() < 0.45;
      const at = later(0.1 + (0.85 * (k + rand())) / attempts);
      calls.push({
        id: demoId(5, calls.length + 1),
        leadId: lead.id,
        agentId: owner.id,
        status: connected ? "COMPLETED" : status === "BUSY" ? "BUSY" : status === "NOT_REACHABLE" || status === "SWITCHED_OFF" ? "NOT_REACHABLE" : weighted([["NO_ANSWER", 6], ["BUSY", 3], ["FAILED", 1]]),
        at,
        durationSeconds: connected ? int(35, 420) : 0,
        notes: connected && rand() < 0.5 ? pick(NOTE_TEXT) : null,
      });
      lead.updatedAt = Math.max(lead.updatedAt, at);
    }
    if (["INTERESTED", "FOLLOW_UP", "CALL_BACK", "CONVERTED"].includes(status)) {
      notes.push({ id: demoId(6, notes.length + 1), leadId: lead.id, actorId: owner.id, at: lead.updatedAt, title: "Note", description: pick(NOTE_TEXT), type: "NOTE" });
    }
    notes.push({ id: demoId(6, notes.length + 1), leadId: lead.id, actorId: owner.id, at: lead.updatedAt, title: `Status changed to ${status.replace(/_/g, " ").toLowerCase()}`, description: null, type: "STATUS_CHANGE" });

    if (status === "CALL_BACK" || status === "FOLLOW_UP") {
      // overdue, due today and upcoming reminders
      const scheduledAt = Math.round(now + weighted<number>([[-int(2, 48) * HOUR, 3], [int(1, 8) * HOUR, 4], [int(1, 6) * DAY, 3]]));
      tasks.push({ id: demoId(7, tasks.length + 1), leadId: lead.id, userId: owner.id, type: status === "CALL_BACK" ? "CALLBACK" : "FOLLOW_UP", description: pick(NOTE_TEXT), scheduledAt, done: false });
    }

    if (status === "CONVERTED") {
      const count = rand() < 0.22 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const product = pick(products);
        const quantity = weighted([[1, 7], [2, 2], [3, 1]]);
        const at = Math.min(now - 60_000, lead.updatedAt - k * int(3, 20) * DAY);
        const method = rand() < 0.55 ? "COD" : "UPI";
        const state = weighted<DemoOrder["status"]>([["DELIVERED", 40], ["SHIPPED", 18], ["PROCESSING", 12], ["CONFIRMED", 24], ["CANCELLED", 6]]);
        orders.push({
          id: demoId(8, orders.length + 1),
          orderNumber: `DEMO-${5000 + orders.length + 1}`,
          leadId: lead.id,
          sellerId: owner.id,
          source: rand() < 0.82 ? "SALESPERSON" : weighted([["SHOPIFY", 1], ["WEBSITE", 1]]),
          status: state,
          method,
          paymentStatus: state === "CANCELLED" ? "FAILED" : method === "UPI" || state === "DELIVERED" ? "SUCCESS" : "PENDING",
          productId: product.id,
          quantity,
          total: product.price * quantity,
          at,
        });
      }
    }
    if (rand() < 0.12) abandonments.push({ id: demoId(9, abandonments.length + 1), leadId: lead.id, at: Math.max(createdAt, now - (rand() < 0.35 ? rand() * (now - midnight) : rand() * 6 * DAY)) });
  }
  return { builtAt: now, users, sources, products, leads, calls, notes, tasks, orders, abandonments };
}
