// Planning of a bulk "assign salesperson": WHO gets WHICH lead, decided before anything is written. Pure functions (no database), so the plan the user previews is the plan the server applies
// and both are easy to test.

export interface PlannedAssignment {
  leadId: string;
  salespersonId: string;
}

/**
 * Round Robin: the leads, in the order given, are dealt one by one across the salespersons, in the order given, always starting with the FIRST salesperson.
 * Even as possible - the first (n mod k) salespersons get one extra: 100 leads over 3 people = 34 / 33 / 33. Deterministic on purpose: the preview shown before confirming
 * is exactly what is saved.
 */
export function roundRobinPlan(leadIds: string[], salespersonIds: string[]): PlannedAssignment[] {
  if (salespersonIds.length === 0) return [];
  return leadIds.map((leadId, i) => ({ leadId, salespersonId: salespersonIds[i % salespersonIds.length]! }));
}

/** How many leads each of `k` salespersons gets when `n` leads are dealt round robin: the counts differ by at most one. */
export function roundRobinCounts(n: number, k: number): number[] {
  if (k <= 0) return [];
  return Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
}

/** Per-salesperson lead counts of a plan, in first-appearance order of `salespersonIds` (salespersons with no lead are included with 0). */
export function summarizePlan(plan: PlannedAssignment[], salespersonIds: string[]): { salespersonId: string; count: number }[] {
  const counts = new Map<string, number>(salespersonIds.map((id) => [id, 0]));
  for (const p of plan) counts.set(p.salespersonId, (counts.get(p.salespersonId) ?? 0) + 1);
  return [...counts].map(([salespersonId, count]) => ({ salespersonId, count }));
}

export class PlanConflictError extends Error {}

/**
 * Turns the user's request into one assignment per distinct lead. `leadIdOf` maps a selected abandoned-lead id to its lead (one lead can have more than one abandoned checkout).
 * Throws PlanConflictError for a request that cannot be honoured exactly: the same lead given to two different salespersons, or a manual choice for a lead that was not selected.
 */
export function buildPlan(input: {
  method: "MANUAL" | "ROUND_ROBIN";
  abandonmentIds: string[];
  leadIdOf: Map<string, string>;
  salespersonIds?: string[];
  salespersonId?: string;
  assignments?: { abandonmentId: string; salespersonId: string }[];
}): PlannedAssignment[] {
  const selected = new Set(input.abandonmentIds);
  const orderedLeads: string[] = [];
  const seenLeads = new Set<string>();
  for (const id of input.abandonmentIds) {
    const leadId = input.leadIdOf.get(id);
    if (leadId && !seenLeads.has(leadId)) {
      seenLeads.add(leadId);
      orderedLeads.push(leadId);
    }
  }

  if (input.method === "ROUND_ROBIN") {
    const people = [...new Set(input.salespersonIds ?? [])];
    return roundRobinPlan(orderedLeads, people);
  }

  const chosen = new Map<string, string>(); // leadId -> salespersonId
  const rows = input.assignments ?? (input.salespersonId ? input.abandonmentIds.map((abandonmentId) => ({ abandonmentId, salespersonId: input.salespersonId! })) : []);
  for (const row of rows) {
    if (!selected.has(row.abandonmentId)) throw new PlanConflictError("An assignment names a lead that is not in the selection");
    const leadId = input.leadIdOf.get(row.abandonmentId);
    if (!leadId) continue;
    const existing = chosen.get(leadId);
    if (existing && existing !== row.salespersonId) throw new PlanConflictError("The same lead was given to two different salespersons");
    chosen.set(leadId, row.salespersonId);
  }
  return [...chosen].map(([leadId, salespersonId]) => ({ leadId, salespersonId }));
}
