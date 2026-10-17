import { createHash } from "node:crypto";

// Durable duplicate protection for manual order creation (see prisma/schema/idempotency.prisma). The pieces that do not need a database.

export const ORDER_CREATE_OPERATION = "ORDER_CREATE";
export const IDEMPOTENCY_COMPLETED = "COMPLETED";
export const IDEMPOTENCY_ORDER_CREATED = "ORDER_CREATED";

/**
 * Timing of the idempotency / Shopify-claim machinery. Production uses the defaults; the tests shorten them (never the safety rules, only the waits).
 *  - waitMs: a Shopify push claim held by another caller is waited for this long (a Shopify request can take that long) before giving up.
 *  - replayWaitMs: a retry of a request still finishing elsewhere waits this long for its answer before reconciling the original operation itself
 *    (the Shopify claim keeps that safe).
 *  - leaseSeconds: a Shopify push claim older than this belongs to a dead process and is taken over. It must comfortably exceed the longest a LIVE push can
 *    take: the Shopify client allows up to 3 attempts x 20s + waits (~80s) per request and a push makes several requests, so 10 minutes. A taken-over claim is
 *    always treated as uncertain (the order is looked up by its source identifier before anything is created).
 */
export const idempotencyTuning = { waitMs: 20_000, replayWaitMs: 4_000, pollMs: 250, leaseSeconds: 600 };

/** Thrown inside createManualOrderOnce when another request with the same key committed first (the unique index decided). */
export class IdempotencyRaceLost extends Error {
  constructor() {
    super("Another request with the same idempotency key committed first");
    this.name = "IdempotencyRaceLost";
  }
}

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
};

/** Fingerprint of WHAT was asked for (never of the key itself): the same key with a different request is refused, not answered with the wrong order. */
export function hashOrderRequest(input: object): string {
  // The key, and the "yes, this is a separate purchase" acknowledgement / guard switch, are not part of WHAT was asked for: a replay with or without them is the same request.
  const { idempotencyKey: _ignored, acknowledgeDuplicate: _ack, rejectRecentTwin: _guard, ...rest } = input as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify(canonical(rest))).digest("hex");
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
