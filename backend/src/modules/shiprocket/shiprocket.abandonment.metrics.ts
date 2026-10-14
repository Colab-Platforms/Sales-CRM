// Operational counters of the Fastrr abandon-cart ingestion. IN MEMORY: they describe THIS server process since it started (a deploy or restart resets them) and are labelled that way
// wherever they are shown. They are counts only - never an event body, a name, a phone number, an email or an address. The durable numbers (received / processed / failed per period, lag,
// carts not yet saved) come from the webhook_events table (see abandonment.ingestion-status.ts).

export interface IngestionCounters {
  received: number;
  duplicates: number;
  unauthorized: number;
  invalidBody: number;
  notConfigured: number;
  unusableNoContact: number;
  processed: number;
  failedAttempts: number;
  exhausted: number;
  autoAssignFailed: number;
  recoveredByReconcile: number;
}

export interface ReconcileSummary {
  at: string;
  examined: number;
  recovered: number;
  failedAgain: number;
  skipped: number;
}

const fresh = (): IngestionCounters => ({ received: 0, duplicates: 0, unauthorized: 0, invalidBody: 0, notConfigured: 0, unusableNoContact: 0, processed: 0, failedAttempts: 0, exhausted: 0, autoAssignFailed: 0, recoveredByReconcile: 0 });

let counters = fresh();
let startedAt = new Date();
let lastReconcile: ReconcileSummary | null = null;

export const ingestionMetrics = {
  inc(name: keyof IngestionCounters, by = 1): void {
    counters[name] += by;
  },
  snapshot(): { sinceProcessStart: string; counters: IngestionCounters; lastReconcile: ReconcileSummary | null } {
    return { sinceProcessStart: startedAt.toISOString(), counters: { ...counters }, lastReconcile };
  },
  setLastReconcile(summary: ReconcileSummary): void {
    lastReconcile = summary;
  },
  /** Tests only. */
  reset(): void {
    counters = fresh();
    startedAt = new Date();
    lastReconcile = null;
  },
};
