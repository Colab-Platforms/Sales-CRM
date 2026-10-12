// Periodic reconciliation of Cashfree payment links whose webhook was missed (no public webhook URL, Cashfree could not reach the server, server was down).
// It asks Cashfree (read-only GET) about each still-open CRM link and applies the answer through the SAME reconciliation the webhook and Refresh use, so a payment
// found here ends in exactly the same state. It never creates a payment, starts a payment or refunds. Still-pending links are left alone.
//   CASHFREE_RECONCILE_MINUTES  how often, in minutes. OPT-IN: unset or 0 = off (so a local/dev server pointed at a real database never reconciles real payments by accident).
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import type { TxRunner } from "../integrations/integrations.common.js";

export const DEFAULT_RECONCILE_MINUTES = 0;
/** Only links young enough to still be payable (plus a day of slack for one that was paid just before expiring). */
const MAX_AGE_HOURS = 24 * 31;
const BATCH = 50;

export function loadReconcileMinutes(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.CASHFREE_RECONCILE_MINUTES ?? "").trim();
  if (raw === "") return DEFAULT_RECONCILE_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RECONCILE_MINUTES;
}

export interface CatchUpPass { checked: number; updated: number; errors: number }

export interface ReconcilerDeps {
  runner: TxRunner;
  reconcile: (paymentId: string) => Promise<"updated" | "unchanged" | "not_found">;
  now?: () => Date;
  onError?: (error: unknown) => void;
}

export function createCashfreeReconciler({ runner, reconcile, now = () => new Date(), onError }: ReconcilerDeps) {
  let running = false;
  const tick = async (): Promise<CatchUpPass | null> => {
    if (running) return null; // never overlapped by the next timer tick
    running = true;
    const pass: CatchUpPass = { checked: 0, updated: 0, errors: 0 };
    try {
      const since = new Date(now().getTime() - MAX_AGE_HOURS * 3_600_000);
      const open = await runner.$transaction((tx) =>
        tx.payment.findMany({
          where: { externalSource: "CASHFREE", status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] }, createdAt: { gte: since } },
          orderBy: { createdAt: "asc" },
          take: BATCH,
          select: { id: true },
        }),
      );
      for (const { id } of open) {
        pass.checked++;
        try {
          if ((await reconcile(id)) === "updated") pass.updated++;
        } catch (error) {
          pass.errors++;
          onError?.(error);
        }
      }
    } catch (error) {
      onError?.(error);
    } finally {
      running = false;
    }
    return pass;
  };
  return { tick };
}
