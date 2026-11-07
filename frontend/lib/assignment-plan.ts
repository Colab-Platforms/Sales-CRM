// The Round Robin used by "Assign Salesperson", identical to the server's (backend abandonment.assign-plan.ts): the selected leads, in order, are dealt one by one across the chosen
// salespeople, in order, always starting with the first - the first (n mod k) people get one extra. Because it is deterministic, the preview shown before confirming is exactly what is saved.

export interface PlannedAssignment {
  abandonmentId: string;
  salespersonId: string;
}

export function roundRobinPlan(abandonmentIds: string[], salespersonIds: string[]): PlannedAssignment[] {
  if (salespersonIds.length === 0) return [];
  return abandonmentIds.map((abandonmentId, i) => ({ abandonmentId, salespersonId: salespersonIds[i % salespersonIds.length]! }));
}

/** How many leads each of `k` people gets from `n` leads: the counts differ by at most one (100 over 3 = 34 / 33 / 33). */
export function roundRobinCounts(n: number, k: number): number[] {
  if (k <= 0) return [];
  return Array.from({ length: k }, (_, i) => Math.floor(n / k) + (i < n % k ? 1 : 0));
}

/** Leads per salesperson for a plan, in the order of `salespersonIds` (people with no lead show 0). */
export function countByPerson(plan: PlannedAssignment[], salespersonIds: string[]): { salespersonId: string; count: number }[] {
  const counts = new Map<string, number>(salespersonIds.map((id) => [id, 0]));
  for (const p of plan) counts.set(p.salespersonId, (counts.get(p.salespersonId) ?? 0) + 1);
  return [...counts].map(([salespersonId, count]) => ({ salespersonId, count }));
}
