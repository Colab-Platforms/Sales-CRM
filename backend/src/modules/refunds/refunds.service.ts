// Refund APPROVAL workflow (Phase 1A): request -> approve / reject. NOTHING here calls Cashfree or any provider, and nothing here changes
// Order.status, Payment.status or Payment.refundedAmount. An APPROVED request only authorizes a refund that a later phase will execute.
//
// Safety properties:
//  - Everything for one order runs under the order's advisory lock (the same lock link creation / payment updates use), so two concurrent
//    requests can never reserve more than the payment's refundable balance. No process-local state is involved.
//  - A decision is a conditional UPDATE ... WHERE status = 'PENDING', so only one of two concurrent decisions can win; decisions are final.
//  - The Activity (audit) row is written in the SAME transaction as the state change.
//  - Scope is the existing lead scope (getLeadScope): out-of-scope orders / requests look like "not found".
import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, RefundExecutionStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { advisoryLock, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { fullName, getRefundablePaymentAmount, scopedOrderWhere } from "../orders/orders.filters.js";
import { canResolveCashfreeIds, isSupersededPayment, refundIneligibleReason } from "./refunds.eligibility.js";
import { refundBalance, SHOPIFY_UNCONFIRMED_REASON } from "./refunds.balance.js";
import type { ListRefundRequestsQuery, OrderRefundInfo, RefundActor, RefundRequestListResult, RefundRequestView, RefundablePaymentView } from "./refunds.types.js";

export const REFUND_REFERENCE_TYPE = "RefundRequest";
/** Statuses that still hold their amount against the payment's refundable balance. */
export const ACTIVE_REFUND_STATUSES: RefundRequestStatus[] = [RefundRequestStatus.PENDING, RefundRequestStatus.APPROVED];
/**
 * A request holds its amount against the payment while it is PENDING or APPROVED - until its refund is COMPLETED. From then on the money is in
 * Payment.refundedAmount, so counting the request as well would take it off the balance twice. (PROCESSING and FAILED executions still hold it.)
 */
export const OPEN_RESERVATION: Prisma.RefundRequestWhereInput = {
  status: { in: ACTIVE_REFUND_STATUSES },
  OR: [{ executionStatus: null }, { executionStatus: { not: RefundExecutionStatus.COMPLETED } }],
};

const REQUESTER_ROLES = new Set<Role>([Role.SALESPERSON, Role.MANAGER, Role.ADMIN]);
const APPROVER_ROLES = new Set<Role>([Role.MANAGER, Role.ADMIN]);

/** Every amount leaves this module as a 2-decimal string, whatever Prisma's Decimal.toString() would print. */
const m2 = (v: { toString(): string }) => fromCents(toCents(v.toString()));
const money = (currency: string, amount: string) => `${currency === "INR" ? "₹" : `${currency} `}${amount}`;

export const REQUEST_SELECT = {
  id: true,
  orderId: true,
  paymentId: true,
  amount: true,
  currency: true,
  reason: true,
  status: true,
  requestedByRole: true,
  decidedByRole: true,
  decisionAt: true,
  decisionNote: true,
  executionStatus: true,
  refundId: true,
  cfRefundId: true,
  providerStatus: true,
  executionStartedAt: true,
  executionCompletedAt: true,
  executedByRole: true,
  failureReason: true,
  createdAt: true,
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
  executedBy: { select: { id: true, name: true } },
  order: { select: { orderNumber: true, status: true, lead: { select: { id: true, firstName: true, lastName: true, mobile: true } } } },
  payment: { select: { id: true, method: true, amount: true, refundedAmount: true } },
} satisfies Prisma.RefundRequestSelect;

export type RequestRow = Prisma.RefundRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

function toView(row: RequestRow, remainingCents: number): RefundRequestView {
  const actor = (u: { id: string; name: string }, role: Role): RefundActor => ({ id: u.id, name: u.name, role });
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
    orderStatus: row.order.status,
    customer: { leadId: row.order.lead.id, name: fullName(row.order.lead.firstName, row.order.lead.lastName), mobile: row.order.lead.mobile },
    paymentId: row.paymentId,
    paymentMethod: row.payment.method,
    currency: row.currency,
    paymentAmount: m2(row.payment.amount),
    refundedAmount: row.payment.refundedAmount ? m2(row.payment.refundedAmount) : "0.00",
    amount: m2(row.amount),
    remainingRefundableAmount: fromCents(remainingCents),
    reason: row.reason,
    status: row.status,
    requestedBy: actor(row.requestedBy, row.requestedByRole),
    decidedBy: row.decidedBy && row.decidedByRole ? actor(row.decidedBy, row.decidedByRole) : null,
    decisionAt: row.decisionAt,
    decisionNote: row.decisionNote,
    executionStatus: row.executionStatus,
    refundId: row.refundId,
    cfRefundId: row.cfRefundId,
    providerStatus: row.providerStatus,
    executionStartedAt: row.executionStartedAt,
    executionCompletedAt: row.executionCompletedAt,
    executedBy: row.executedBy && row.executedByRole ? actor(row.executedBy, row.executedByRole) : null,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

/** Active (pending/approved) requests per payment, for the given payments. */
async function activeByPayment(db: Db, paymentIds: string[]): Promise<Map<string, { amount: { toString(): string } }[]>> {
  const map = new Map<string, { amount: { toString(): string } }[]>();
  if (paymentIds.length === 0) return map;
  const rows = await db.refundRequest.findMany({ where: { paymentId: { in: paymentIds }, ...OPEN_RESERVATION }, select: { paymentId: true, amount: true } });
  for (const r of rows) map.set(r.paymentId, [...(map.get(r.paymentId) ?? []), r]);
  return map;
}

export async function viewsFor(db: Db, rows: RequestRow[]): Promise<RefundRequestView[]> {
  const active = await activeByPayment(db, [...new Set(rows.map((r) => r.paymentId))]);
  return rows.map((r) => toView(r, getRefundablePaymentAmount(r.payment, active.get(r.paymentId) ?? []).refundableCents));
}

/** What the order detail needs: each payment's refund eligibility + balance, and the order's refund requests (newest first). */
export async function loadOrderRefundInfo(db: Db, orderId: string): Promise<OrderRefundInfo> {
  const allPayments = await db.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    select: { id: true, method: true, status: true, currency: true, amount: true, refundedAmount: true, externalSource: true, provider: true, providerPaymentId: true, metadata: true },
  });
  // A payment retired by a COD -> Prepaid upgrade stays in the database (history) but is not a refund candidate and is not listed here.
  const payments = allPayments.filter((p) => !isSupersededPayment(p.metadata));
  const orderRow = await db.order.findUnique({ where: { id: orderId }, select: { metadata: true, status: true } });
  const active = await activeByPayment(db, payments.map((p) => p.id));
  const paymentViews: RefundablePaymentView[] = payments.map((p) => {
    // The lower of the CRM's balance and (for a Shopify payment) Shopify's own remaining refundable amount; an unknown Shopify figure blocks the refund.
    const balance = refundBalance(p, active.get(p.id) ?? [], orderRow?.metadata ?? null);
    const calc = balance.calc;
    const reason = refundIneligibleReason(p) ?? balance.blockedReason;
    const eligible = reason === null && balance.refundableCents > 0;
    return {
      paymentId: p.id,
      method: p.method,
      status: p.status,
      currency: p.currency,
      amount: m2(p.amount),
      refundedAmount: fromCents(calc.refundedCents),
      reservedAmount: fromCents(calc.reservedCents),
      refundableAmount: fromCents(balance.refundableCents),
      shopifyRefundableAmount: balance.shopifyCents === null ? null : fromCents(balance.shopifyCents),
      limitedByShopify: balance.limitedByShopify,
      eligible,
      // The retry is offered while the payment is not verified, or is verified but Shopify's refundable amount has not been read (the retry re-reads both).
      canResolve: !eligible && (canResolveCashfreeIds(p) || (refundIneligibleReason(p) === null && balance.blockedReason === SHOPIFY_UNCONFIRMED_REASON)),
      ineligibleReason: reason ?? (balance.refundableCents > 0 ? null : balance.limitedByShopify ? "Shopify reports nothing left to refund on this order." : "Nothing is left to refund on this payment (it is fully refunded or fully covered by open refund requests)."),
    };
  });
  const rows = await db.refundRequest.findMany({ where: { orderId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: REQUEST_SELECT });
  return { orderStatus: orderRow?.status ?? null, payments: paymentViews, requests: await viewsFor(db, rows) };
}

/** What the approval needs from the order's own cancellation (the existing, idempotent OrdersService.cancelOrder): the order's status afterwards and Shopify's outcome. */
export type CancelOrderFn = (user: AuthUser, orderId: string, reason: string) => Promise<{ order: { status: string }; shopify: { status: string; reason?: string } }>;
export interface RefundsServiceDeps {
  /** Cancels the order when a refund is approved. Default: the real OrdersService (loaded lazily - the orders module imports this one). Injected in tests. */
  cancelOrder?: CancelOrderFn;
}

const defaultCancelOrder: CancelOrderFn = async (user, orderId, reason) => {
  const { default: OrdersService } = await import("../orders/orders.service.js");
  // Only reached from approve(), which is manager/admin only: the approver cancels the order whichever team its customer belongs to.
  return new OrdersService().cancelOrder(user, orderId, { reason }, { approverScope: true });
};

/**
 * Refund APPROVAL is a company-wide queue: every manager and every admin sees every pending request and may decide it (never their own), whichever team the
 * telecaller or the customer belongs to. Requesting a refund stays inside the requester's own lead scope (createRequest) - only deciding/viewing is global.
 */
const APPROVER_SCOPE: Prisma.LeadWhereInput = {};

class RefundsService {
  constructor(
    private readonly runner: TxRunner = prisma,
    private readonly deps: RefundsServiceDeps = {},
  ) {}

  /** Raises a refund request against one payment. Validates everything from the database and reserves the amount atomically. */
  async createRequest(user: AuthUser, orderId: string, input: { paymentId: string; amount: string; reason: string; submissionKey?: string }): Promise<RefundRequestView> {
    if (!REQUESTER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const requestedCents = toCents(input.amount);
    if (!Number.isInteger(requestedCents) || requestedCents <= 0) throw new ApiError("The refund amount must be greater than 0", STATUS_CODES.BAD_REQUEST);
    const reason = input.reason.trim();
    if (!reason) throw new ApiError("A reason is required", STATUS_CODES.BAD_REQUEST);

    return this.runner.$transaction(async (tx) => {
      const scope = await getLeadScope(user, tx);
      const order = await tx.order.findFirst({ where: scopedOrderWhere(orderId, scope), select: { id: true, leadId: true, orderNumber: true, status: true, metadata: true } });
      // Out-of-scope orders look the same as missing ones so ids can't be probed.
      if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);

      // From here on nothing else can reserve / pay / change a payment of this order until this transaction ends.
      await advisoryLock(tx, orderLockKey(order.id));

      if (input.submissionKey) {
        const existing = await tx.refundRequest.findUnique({ where: { requestedById_submissionKey: { requestedById: user.id, submissionKey: input.submissionKey } }, select: { ...REQUEST_SELECT } });
        // The same browser submission again (double click / retry): return the request already created, never a second one.
        if (existing) {
          if (existing.orderId !== order.id || existing.paymentId !== input.paymentId || toCents(existing.amount.toString()) !== requestedCents) {
            throw new ApiError("This submission was already used for a different refund request", STATUS_CODES.CONFLICT);
          }
          return (await viewsFor(tx, [existing]))[0]!;
        }
      }

      const payment = await tx.payment.findFirst({
        where: { id: input.paymentId, orderId: order.id },
        select: { id: true, method: true, status: true, currency: true, amount: true, refundedAmount: true, externalSource: true, provider: true, providerPaymentId: true, metadata: true },
      });
      if (!payment) throw new ApiError("That payment does not belong to this order", STATUS_CODES.BAD_REQUEST);

      const ineligible = refundIneligibleReason(payment);
      if (ineligible) throw new ApiError(ineligible, STATUS_CODES.BAD_REQUEST);

      const active = await tx.refundRequest.findMany({ where: { paymentId: payment.id, ...OPEN_RESERVATION }, select: { amount: true } });
      const balance = refundBalance(payment, active, order.metadata);
      const calc = balance.calc;
      if (balance.blockedReason) throw new ApiError(balance.blockedReason, STATUS_CODES.BAD_REQUEST);
      if (balance.refundableCents <= 0) throw new ApiError(balance.limitedByShopify ? "Shopify reports nothing left to refund on this order" : "Nothing is left to refund on this payment", STATUS_CODES.BAD_REQUEST);
      if (requestedCents > calc.originalCents) throw new ApiError(`The refund amount can not exceed the payment amount (${money(payment.currency, fromCents(calc.originalCents))})`, STATUS_CODES.BAD_REQUEST);
      if (requestedCents > calc.refundableCents) {
        throw new ApiError(`Only ${money(payment.currency, fromCents(calc.refundableCents))} can still be refunded on this payment (already refunded or held by open refund requests)`, STATUS_CODES.BAD_REQUEST);
      }
      if (requestedCents > balance.refundableCents) {
        throw new ApiError(`Only ${money(payment.currency, fromCents(balance.refundableCents))} can be refunded: Shopify reports ${money(payment.currency, fromCents(balance.shopifyCents ?? 0))} refundable on this order`, STATUS_CODES.BAD_REQUEST);
      }

      const created = await tx.refundRequest.create({
        data: {
          orderId: order.id,
          paymentId: payment.id,
          requestedById: user.id,
          requestedByRole: user.role,
          amount: fromCents(requestedCents),
          currency: payment.currency,
          reason,
          status: RefundRequestStatus.PENDING,
          submissionKey: input.submissionKey ?? null,
        },
        select: REQUEST_SELECT,
      });
      await tx.activity.create({
        data: {
          leadId: order.leadId,
          orderId: order.id,
          actorId: user.id,
          actorRole: user.role,
          type: ActivityType.REFUND_REQUESTED,
          referenceType: REFUND_REFERENCE_TYPE,
          referenceId: created.id,
          source: ActivitySource.USER,
          title: `Refund of ${money(payment.currency, fromCents(requestedCents))} requested for order ${order.orderNumber}`,
          description: reason,
          oldValue: undefined,
          newValue: { status: RefundRequestStatus.PENDING, amount: fromCents(requestedCents), paymentId: payment.id } as Prisma.InputJsonValue,
          metadata: { refundRequestId: created.id, awaitingApproval: true } as Prisma.InputJsonValue,
        },
      });
      return (await viewsFor(tx, [created]))[0]!;
    });
  }

  /**
   * Approving a refund CANCELS THE ORDER, then records the approval:
   *   1. validate (read-only): the request is in scope, pending, not the approver's own, and its payment is still refundable;
   *   2. cancel the order through the existing OrdersService.cancelOrder (idempotent: an already cancelled order is not cancelled twice, Shopify / open payment links are
   *      handled by it). If the cancellation fails - including Shopify refusing to cancel a linked order - the refund is NOT approved: the request stays PENDING with a
   *      clear error, and approving again retries only what is outstanding;
   *   3. record the decision in the locked, conditional transaction (a duplicate approval loses there: no second decision, no second audit event).
   * The cancellation itself is audited by cancelOrder (ORDER_CANCELLED); the approval writes REFUND_APPROVED.
   */
  async approve(user: AuthUser, id: string, note?: string): Promise<RefundRequestView> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);

    const pre = await this.runner.$transaction(async (tx) => {
      const scope = APPROVER_SCOPE;
      const found = await tx.refundRequest.findFirst({ where: { id, ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) }, select: { ...REQUEST_SELECT } });
      if (!found) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);
      if (found.requestedBy.id === user.id) throw new ApiError("You can not approve or reject your own refund request", STATUS_CODES.FORBIDDEN);
      if (found.status !== RefundRequestStatus.PENDING) throw new ApiError(`This refund request was already ${found.status.toLowerCase()}. A decision can not be changed.`, STATUS_CODES.CONFLICT);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: found.paymentId }, select: { status: true, method: true, provider: true, externalSource: true, providerPaymentId: true, metadata: true } });
      const ineligible = refundIneligibleReason(payment);
      if (ineligible) throw new ApiError(`This refund can no longer be approved: ${ineligible}`, STATUS_CODES.CONFLICT);
      const order = await tx.order.findUniqueOrThrow({ where: { id: found.orderId }, select: { status: true, externalId: true, metadata: true } });
      const shopifyCancel = (order.metadata as { shopifyCancellation?: { status?: string } } | null)?.shopifyCancellation;
      return { orderId: found.orderId, needsCancel: order.status !== OrderStatus.CANCELLED || (!!order.externalId && shopifyCancel?.status === "failed") };
    });

    if (pre.needsCancel) {
      let result: Awaited<ReturnType<CancelOrderFn>>;
      try {
        result = await (this.deps.cancelOrder ?? defaultCancelOrder)(user, pre.orderId, `Order cancelled because refund request ${id} was approved`);
      } catch (error) {
        throw new ApiError(`The order could not be cancelled, so the refund was NOT approved: ${error instanceof Error ? error.message : "unknown error"}`, 502);
      }
      if (result.order.status !== OrderStatus.CANCELLED) throw new ApiError("The order could not be cancelled, so the refund was NOT approved.", 502);
      if (result.shopify.status === "failed") {
        throw new ApiError(`The order was cancelled in the CRM but could not be cancelled in Shopify (${result.shopify.reason ?? "no reason given"}), so the refund was NOT approved. Approve again to retry.`, 502);
      }
    }
    return this.decide(user, id, RefundRequestStatus.APPROVED, note ?? null, { orderCancelledByApproval: pre.needsCancel });
  }

  async reject(user: AuthUser, id: string, note: string): Promise<RefundRequestView> {
    if (!note || !note.trim()) throw new ApiError("A rejection reason is required", STATUS_CODES.BAD_REQUEST);
    return this.decide(user, id, RefundRequestStatus.REJECTED, note.trim());
  }

  private async decide(user: AuthUser, id: string, to: "APPROVED" | "REJECTED", note: string | null, extra: { orderCancelledByApproval?: boolean } = {}): Promise<RefundRequestView> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    return this.runner.$transaction(async (tx) => {
      const head = await tx.refundRequest.findUnique({ where: { id }, select: { orderId: true } });
      if (!head) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);
      await advisoryLock(tx, orderLockKey(head.orderId));

      const scope = APPROVER_SCOPE;
      const found = await tx.refundRequest.findFirst({ where: { id, ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) }, select: { ...REQUEST_SELECT } });
      if (!found) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);

      // Server-side: nobody decides their own request, whatever the UI shows.
      if (found.requestedBy.id === user.id) throw new ApiError("You can not approve or reject your own refund request", STATUS_CODES.FORBIDDEN);
      // Approval cancels the order first (see approve); if it was reactivated since, the approval is not recorded (an approved refund always sits on a cancelled order).
      if (to === RefundRequestStatus.APPROVED && found.order.status !== OrderStatus.CANCELLED) throw new ApiError("The order is not cancelled (it was reactivated while this approval ran), so the refund was NOT approved. Approve again.", STATUS_CODES.CONFLICT);
      if (found.status !== RefundRequestStatus.PENDING) {
        throw new ApiError(`This refund request was already ${found.status.toLowerCase()}. A decision can not be changed.`, STATUS_CODES.CONFLICT);
      }

      const now = new Date();
      // The transition itself is conditional, so two simultaneous decisions can never both succeed.
      const { count } = await tx.refundRequest.updateMany({
        where: { id, status: RefundRequestStatus.PENDING },
        data: { status: to, decidedById: user.id, decidedByRole: user.role, decisionAt: now, decisionNote: note },
      });
      if (count === 0) throw new ApiError("This refund request was already decided. A decision can not be changed.", STATUS_CODES.CONFLICT);

      const order = await tx.order.findUniqueOrThrow({ where: { id: found.orderId }, select: { leadId: true, orderNumber: true } });
      const amountLabel = money(found.currency, m2(found.amount));
      await tx.activity.create({
        data: {
          leadId: order.leadId,
          orderId: found.orderId,
          actorId: user.id,
          actorRole: user.role,
          type: to === "APPROVED" ? ActivityType.REFUND_APPROVED : ActivityType.REFUND_REJECTED,
          referenceType: REFUND_REFERENCE_TYPE,
          referenceId: id,
          source: ActivitySource.USER,
          title: to === "APPROVED" ? `Refund of ${amountLabel} approved for order ${order.orderNumber}${extra.orderCancelledByApproval ? " (the order was cancelled by this approval)" : ""} - not refunded yet` : `Refund of ${amountLabel} rejected for order ${order.orderNumber}`,
          description: note,
          oldValue: { status: RefundRequestStatus.PENDING } as Prisma.InputJsonValue,
          newValue: { status: to, amount: m2(found.amount) } as Prisma.InputJsonValue,
          metadata: { refundRequestId: id, requestedById: found.requestedBy.id, ...(to === "APPROVED" ? { refundExecuted: false, orderCancelledByApproval: !!extra.orderCancelledByApproval } : {}) } as Prisma.InputJsonValue,
        },
      });

      const updated = await tx.refundRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT });
      return (await viewsFor(tx, [updated]))[0]!;
    });
  }

  /** The approval queue / history. Scoped like every order read; callers (routes) already require MANAGER or ADMIN. */
  async list(user: AuthUser, query: ListRefundRequestsQuery): Promise<RefundRequestListResult> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    return this.runner.$transaction(async (tx) => {
      const scope = APPROVER_SCOPE;
      const where: Prisma.RefundRequestWhereInput = {
        ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}),
        ...(query.status !== "ALL" ? { status: query.status } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
        ...(query.requestedById ? { requestedById: query.requestedById } : {}),
        ...(query.from || query.to ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } } : {}),
      };
      const [totalItems, rows] = await Promise.all([
        tx.refundRequest.count({ where }),
        tx.refundRequest.findMany({ where, orderBy: [{ createdAt: "asc" }, { id: "asc" }], skip: (query.page - 1) * query.pageSize, take: query.pageSize, select: REQUEST_SELECT }),
      ]);
      return { items: await viewsFor(tx, rows), pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) } };
    });
  }

  /** How many pending requests THIS user could act on (any team, not their own) - the sidebar badge. */
  async pendingCount(user: AuthUser): Promise<{ count: number }> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    return this.runner.$transaction(async (tx) => {
      const scope = APPROVER_SCOPE;
      const count = await tx.refundRequest.count({
        where: { status: RefundRequestStatus.PENDING, requestedById: { not: user.id }, ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) },
      });
      return { count };
    });
  }
}

export default RefundsService;
