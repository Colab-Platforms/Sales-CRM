// E7.6 Lifecycle Automation - the two time-based automations (PAYMENT_PENDING, FOLLOW_UP_DUE) are
// not a single discrete transition the way an order becoming CONFIRMED/SHIPPED/... is, so they are
// driven by a periodic sweep instead - same in-process setInterval shape as
// whatsapp.webhook.worker.ts's retry loop (this codebase's one existing "background job"
// convention; there is no Celery/Bull/cron here to reuse instead).
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { logger } from "@/utils/logger.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown } from "../orders/orders.filters.js";
import { deriveReconciliationStatus } from "../reconciliation/reconciliation.filters.js";
import { toCents } from "../shopify/shopify.money.js";
import LifecycleAutomationService from "./whatsapp.automation.service.js";
import { followUpDueEventKey, paymentPendingEventKey } from "./whatsapp.automation.triggers.js";

export interface SweepResult {
  scanned: number;
  dispatched: number;
}

// A closed order never gets a payment nudge - the task's own explicit "avoid sending a payment
// reminder for ... cancelled/refunded cases" requirement. DRAFT is excluded too: a CRM-side order
// still being put together was never actually placed with the customer yet.
const PAYMENT_REMINDER_EXCLUDED_STATUSES = ["CANCELLED", "RETURNED", "REFUNDED", "DRAFT"] as const;
// A defensive per-tick cap, not a real-world scale limit - the eventKey's per-day claim already
// means a slow/late sweep never double-sends, it just catches up on the next tick.
const SWEEP_BATCH_SIZE = 500;

/**
 * Finds every order that is "genuinely pending" by the CRM's own existing reconciliation
 * definition (never a second one - see reconciliation.filters.ts's deriveReconciliationStatus) and
 * dispatches PAYMENT_PENDING for each, once per order per calendar day (paymentPendingEventKey).
 *
 * `where` narrows which orders are scanned (AND-combined with the built-in exclusion below) - the
 * production scheduler tick never passes one (sweeps every open order), while a test scopes it to
 * just the orders it created, so it never touches the rest of a shared dev database's real order
 * history.
 */
export async function sweepPaymentPendingAutomation(now: Date = new Date(), db: DbClient = prisma, automation: LifecycleAutomationService = new LifecycleAutomationService(db), where: Prisma.OrderWhereInput = {}): Promise<SweepResult> {
  const orders = await db.order.findMany({
    where: { AND: [{ status: { notIn: [...PAYMENT_REMINDER_EXCLUDED_STATUSES] } }, where] },
    select: { id: true, leadId: true, totalAmount: true, payments: { select: { status: true, amount: true, refundedAmount: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: SWEEP_BATCH_SIZE,
  });

  let dispatched = 0;
  for (const order of orders) {
    const breakdown = computePaymentBreakdown(order.payments);
    const reconciliationStatus = deriveReconciliationStatus(toCents(order.totalAmount.toString()), breakdown, order.payments.length > 0);
    if (reconciliationStatus !== "PENDING" && reconciliationStatus !== "PARTIALLY_PAID") continue;

    const outcome = await automation.dispatch({ type: "PAYMENT_PENDING", leadId: order.leadId, orderId: order.id, eventKey: paymentPendingEventKey(order.id, now) });
    if (outcome.outcome === "sent") dispatched++;
  }
  return { scanned: orders.length, dispatched };
}

/**
 * Finds every due, still-pending follow-up Task (the CRM's existing follow-up model - see
 * tasks.prisma; no second follow-up system is introduced) and dispatches FOLLOW_UP_DUE for each,
 * at most once ever per task (followUpDueEventKey).
 */
export async function sweepFollowUpDueAutomation(now: Date = new Date(), db: DbClient = prisma, automation: LifecycleAutomationService = new LifecycleAutomationService(db)): Promise<SweepResult> {
  const tasks = await db.task.findMany({
    where: { type: "FOLLOW_UP", status: "PENDING", scheduledAt: { lte: now } },
    select: { id: true, leadId: true },
    orderBy: [{ scheduledAt: "asc" }, { id: "asc" }],
    take: SWEEP_BATCH_SIZE,
  });

  let dispatched = 0;
  for (const task of tasks) {
    const outcome = await automation.dispatch({ type: "FOLLOW_UP_DUE", leadId: task.leadId, eventKey: followUpDueEventKey(task.id) });
    if (outcome.outcome === "sent") dispatched++;
  }
  return { scanned: tasks.length, dispatched };
}

export interface SchedulerHandle {
  tick: () => Promise<void>;
  stop: () => void;
}

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // hourly: reminders/follow-ups are not time-critical to the minute

export function startLifecycleAutomationScheduler(intervalMs = DEFAULT_INTERVAL_MS): SchedulerHandle {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const [payment, followUp] = await Promise.all([sweepPaymentPendingAutomation(now), sweepFollowUpDueAutomation(now)]);
      logger.info(`WhatsApp lifecycle automation sweep: payment-pending ${payment.dispatched}/${payment.scanned}, follow-up-due ${followUp.dispatched}/${followUp.scanned}`);
    } catch (error) {
      logger.error("WhatsApp lifecycle automation sweep failed", error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
