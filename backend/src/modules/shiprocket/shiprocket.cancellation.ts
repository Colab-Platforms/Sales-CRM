// Shiprocket side of cancelling a CRM order: the stored record (Order.metadata.shiprocketCancellation) and the pure decision of what a given shipment needs.
// Deliberately its own metadata key - separate from shopifyCancellation, paymentLinkCancellation and shiprocketSync - so the integrations never read or overwrite each other.
//
// Statuses (what the order page shows):
//   PENDING    a cancellation request is being sent right now (also the lock that stops a second click from sending another)
//   REQUESTED  Shiprocket accepted the request but has not been seen to show the order as cancelled yet
//   CANCELLED  Shiprocket itself reports the order cancelled (read back from Shiprocket, or its own tracking webhook) - never set on the strength of our request alone
//   FAILED     nothing was cancelled (Shiprocket refused, was unreachable, or the shipment is too far along); `error` holds the actual reason and the action can be retried
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShipmentStatus } from "../../../generated/prisma/enums.js";
import { asRecord } from "../integrations/integrations.common.js";

export type ShiprocketCancelStatus = "PENDING" | "REQUESTED" | "CANCELLED" | "FAILED";

export interface ShiprocketCancellationRecord {
  status: ShiprocketCancelStatus;
  /** Cancellation requests actually sent to Shiprocket (a status check alone does not count). */
  attempts: number;
  lastAttemptAt: string | null;
  requestedAt: string | null;
  /** When Shiprocket was seen to report the order cancelled. */
  cancelledAt: string | null;
  /** The Shiprocket order id the request used (never the CRM order number or the channel order id). */
  shiprocketOrderId: string | null;
  awb: string | null;
  /** The AWB booking has been cancelled at Shiprocket (only for a shipment that had one); kept so a retry does not repeat it. */
  awbCancelled: boolean;
  /** Safe, readable reason of the last failure (Shiprocket's own text when it refused); null when none. */
  error: string | null;
  /** Shiprocket's reply to the order cancellation, trimmed. */
  response: string | null;
  awbResponse: string | null;
}

export function readShiprocketCancellation(metadata: unknown): ShiprocketCancellationRecord | null {
  const r = asRecord(asRecord(metadata).shiprocketCancellation);
  if (typeof r.status !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status: r.status as ShiprocketCancelStatus,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    lastAttemptAt: str(r.lastAttemptAt),
    requestedAt: str(r.requestedAt),
    cancelledAt: str(r.cancelledAt),
    shiprocketOrderId: str(r.shiprocketOrderId),
    awb: str(r.awb),
    awbCancelled: r.awbCancelled === true,
    error: str(r.error),
    response: str(r.response),
    awbResponse: str(r.awbResponse),
  };
}

type Raw = Pick<Prisma.TransactionClient, "$executeRaw">;

/** Atomically merges `patch` into metadata.shiprocketCancellation (one UPDATE: a concurrent writer of any other metadata key is not overwritten). */
export async function mergeShiprocketCancellation(db: Raw, orderId: string, patch: Partial<ShiprocketCancellationRecord>): Promise<void> {
  const json = JSON.stringify(patch);
  await db.$executeRaw`UPDATE orders SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('shiprocketCancellation', COALESCE(metadata->'shiprocketCancellation', '{}'::jsonb) || ${json}::jsonb) WHERE id = ${orderId}::uuid`;
}

/** Text Shiprocket uses for a cancelled order ("CANCELED" / "Cancelled" / "CANCELLATION REQUESTED" is NOT cancelled yet). */
export const isCancelledText = (text: string | null | undefined): boolean => !!text && /^cancel+ed$/i.test(text.trim());

export interface ShipmentForCancel {
  status: ShipmentStatus;
  providerStatus: string | null;
  providerOrderId: string | null;
  externalId: string | null;
  trackingNumber: string | null;
}

export type CancelPlan =
  | { kind: "none" }
  /** The shipment row is still being created: its Shiprocket order does not exist yet, so there is nothing to cancel by id. */
  | { kind: "submitting" }
  /** The CRM already knows Shiprocket reports it cancelled (its tracking webhook said so). */
  | { kind: "already_cancelled"; shiprocketOrderId: string }
  | { kind: "too_far"; shiprocketOrderId: string; reason: string }
  | { kind: "cancel"; shiprocketOrderId: string; awb: string | null };

const PRE_PICKUP = new Set<ShipmentStatus>([ShipmentStatus.CREATED, ShipmentStatus.AWB_ASSIGNED, ShipmentStatus.PICKUP_SCHEDULED]);

/** Pure. What cancelling the order means for its latest Shiprocket shipment. */
export function planCancellation(shipment: ShipmentForCancel | null): CancelPlan {
  if (!shipment) return { kind: "none" };
  if (!shipment.providerOrderId) return shipment.externalId?.startsWith("pending:") && shipment.status === ShipmentStatus.CREATED ? { kind: "submitting" } : { kind: "none" };
  const id = shipment.providerOrderId;
  if (shipment.status === ShipmentStatus.CANCELLED) return { kind: "already_cancelled", shiprocketOrderId: id };
  if (!PRE_PICKUP.has(shipment.status)) {
    const where = shipment.providerStatus ?? shipment.status.toLowerCase().replace(/_/g, " ");
    return { kind: "too_far", shiprocketOrderId: id, reason: `The shipment is already ${where}, so Shiprocket can no longer cancel it. Stop it with the courier or handle it as a return.` };
  }
  // An AWB means a courier is booked: that booking is cancelled first, then the order.
  return { kind: "cancel", shiprocketOrderId: id, awb: shipment.trackingNumber };
}

/**
 * Marks the CRM's cancellation request as CANCELLED, but only when one exists and is not already confirmed (a cancellation Shiprocket did on its own, with no CRM request, creates no record).
 * Called once Shiprocket itself has shown the order as cancelled - by a read-back or by its tracking webhook.
 */
export async function confirmShiprocketCancellation(db: Raw, orderId: string, at: Date): Promise<void> {
  const iso = at.toISOString();
  await db.$executeRaw`UPDATE orders SET metadata = jsonb_set(metadata, '{shiprocketCancellation}', (metadata->'shiprocketCancellation') || jsonb_build_object('status', 'CANCELLED', 'cancelledAt', ${iso}::text, 'error', NULL)) WHERE id = ${orderId}::uuid AND metadata->'shiprocketCancellation'->>'status' IN ('PENDING', 'REQUESTED', 'FAILED')`;
}
