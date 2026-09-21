import { LEASE_MS, MAX_ATTEMPTS, type StoredEvent, type WebhookStore } from "../shopify/shopify.webhook.store.js";

// Test-only helpers shared by the Cashfree and Shiprocket unit tests. Not imported by any production code.

export interface MemoryRow {
  id: string;
  eventType: string;
  externalEventId: string;
  payload: unknown;
  status: "RECEIVED" | "PROCESSING" | "PROCESSED" | "FAILED" | "IGNORED";
  attempts: number;
  nextAttemptAt: Date | null;
  errorMessage: string | null;
  receivedAt: Date;
}

/** An in-memory WebhookStore that behaves like the database one: unique delivery id, atomic claim, lease. */
export function memoryStore() {
  const rows: MemoryRow[] = [];
  const store: WebhookStore = {
    async record({ eventType, externalEventId, payload, ignored }) {
      const existing = rows.find((r) => r.externalEventId === externalEventId);
      if (existing) return { id: existing.id, duplicate: true };
      const row: MemoryRow = { id: `evt-${rows.length + 1}`, eventType, externalEventId, payload, status: ignored ? "IGNORED" : "RECEIVED", attempts: 0, nextAttemptAt: null, errorMessage: null, receivedAt: new Date() };
      rows.push(row);
      return { id: row.id, duplicate: false };
    },
    async claim(id, now) {
      const row = rows.find((r) => r.id === id);
      const claimable = row && (row.status === "RECEIVED" || ((row.status === "FAILED" || row.status === "PROCESSING") && row.nextAttemptAt !== null && row.nextAttemptAt <= now));
      if (!row || !claimable) return null;
      row.status = "PROCESSING";
      row.attempts += 1;
      row.nextAttemptAt = new Date(now.getTime() + LEASE_MS);
      return { id: row.id, eventType: row.eventType, payload: row.payload, attempts: row.attempts } satisfies StoredEvent;
    },
    async complete(id, status) {
      const row = rows.find((r) => r.id === id)!;
      row.status = status;
      row.errorMessage = null;
      row.nextAttemptAt = null;
    },
    async fail(id, message, nextAttemptAt) {
      const row = rows.find((r) => r.id === id)!;
      row.status = "FAILED";
      row.errorMessage = message;
      row.nextAttemptAt = nextAttemptAt;
    },
    async due(now, limit) {
      return rows
        .filter(
          (r) =>
            (r.status === "RECEIVED" && r.receivedAt.getTime() <= now.getTime() - 30_000) ||
            (r.status === "FAILED" && r.nextAttemptAt !== null && r.nextAttemptAt <= now && r.attempts < MAX_ATTEMPTS) ||
            (r.status === "PROCESSING" && r.nextAttemptAt !== null && r.nextAttemptAt <= now),
        )
        .slice(0, limit)
        .map((r) => r.id);
    },
  };
  return { store, rows };
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch stand-in that answers from a queue and records what was sent. Each answer is [status, json] or an Error to
 * throw (a network failure).
 */
export function fakeFetch(answers: Array<[number, unknown] | Error>) {
  const calls: RecordedCall[] = [];
  const queue = [...answers];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch: no answer queued");
    if (next instanceof Error) throw next;
    const [status, json] = next;
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}
