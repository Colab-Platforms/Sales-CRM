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
import { ActivitySource, ActivityType, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { advisoryLock, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { fullName, getRefundablePaymentAmount, scopedOrderWhere } from "../orders/orders.filters.js";
import { refundIneligibleReason } from "./refunds.eligibility.js";
import type { ListRefundRequestsQuery, OrderRefundInfo, RefundActor, RefundRequestListResult, RefundRequestView, RefundablePaymentView } from "./refunds.types.js";

export const REFUND_REFERENCE_TYPE = "RefundRequest";
/** Statuses that still hold their amount against the payment's refundable balance. */
export const ACTIVE_REFUND_STATUSES: RefundRequestStatus[] = [RefundRequestStatus.PENDING, RefundRequestStatus.APPROVED];

const REQUESTER_ROLES = new Set<Role>([Role.SALESPERSON, Role.MANAGER, Role.ADMIN]);
const APPROVER_ROLES = new Set<Role>([Role.MANAGER, Role.ADMIN]);

/** Every amount leaves this module as a 2-decimal string, whatever Prisma's Decimal.toString() would print. */
const m2 = (v: { toString(): string }) => fromCents(toCents(v.toString()));
const money = (currency: string, amount: string) => `${currency === "INR" ? "₹" : `${currency} `}${amount}`;

const REQUEST_SELECT = {
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
  createdAt: true,
  requestedBy: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
  order: { select: { orderNumber: true, lead: { select: { id: true, firstName: true, lastName: true, mobile: true } } } },
  payment: { select: { id: true, method: true, amount: true, refundedAmount: true } },
} satisfies Prisma.RefundRequestSelect;

type RequestRow = Prisma.RefundRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

function toView(row: RequestRow, remainingCents: number): RefundRequestView {
  const actor = (u: { id: string; name: string }, role: Role): RefundActor => ({ id: u.id, name: u.name, role });
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.order.orderNumber,
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
    createdAt: row.createdAt,
  };
}

/** Active (pending/approved) requests per payment, for the given payments. */
async function activeByPayment(db: Db, paymentIds: string[]): Promise<Map<string, { amount: { toString(): string } }[]>> {
  const map = new Map<string, { amount: { toString(): string } }[]>();
  if (paymentIds.length === 0) return map;
  const rows = await db.refundRequest.findMany({ where: { paymentId: { in: paymentIds }, status: { in: ACTIVE_REFUND_STATUSES } }, select: { paymentId: true, amount: true } });
  for (const r of rows) map.set(r.paymentId, [...(map.get(r.paymentId) ?? []), r]);
  return map;
}

async function viewsFor(db: Db, rows: RequestRow[]): Promise<RefundRequestView[]> {
  const active = await activeByPayment(db, [...new Set(rows.map((r) => r.paymentId))]);
  return rows.map((r) => toView(r, getRefundablePaymentAmount(r.payment, active.get(r.paymentId) ?? []).refundableCents));
}

/** What the order detail needs: each payment's refund eligibility + balance, and the order's refund requests (newest first). */
export async function loadOrderRefundInfo(db: Db, orderId: string): Promise<OrderRefundInfo> {
  const payments = await db.payment.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    select: { id: true, method: true, status: true, currency: true, amount: true, refundedAmount: true, externalSource: true, providerPaymentId: true, metadata: true },
  });
  const active = await activeByPayment(db, payments.map((p) => p.id));
  const paymentViews: RefundablePaymentView[] = payments.map((p) => {
    const calc = getRefundablePaymentAmount(p, active.get(p.id) ?? []);
    const reason = refundIneligibleReason(p);
    const eligible = reason === null && calc.refundableCents > 0;
    return {
      paymentId: p.id,
      method: p.method,
      status: p.status,
      currency: p.currency,
      amount: m2(p.amount),
      refundedAmount: fromCents(calc.refundedCents),
      reservedAmount: fromCents(calc.reservedCents),
      refundableAmount: fromCents(calc.refundableCents),
      eligible,
      ineligibleReason: reason ?? (calc.refundableCents > 0 ? null : "Nothing is left to refund on this payment (it is fully refunded or fully covered by open refund requests)."),
    };
  });
  const rows = await db.refundRequest.findMany({ where: { orderId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: REQUEST_SELECT });
  return { payments: paymentViews, requests: await viewsFor(db, rows) };
}

class RefundsService {
  constructor(private readonly runner: TxRunner = prisma) {}

  /** Raises a refund request against one payment. Validates everything from the database and reserves the amount atomically. */
  async createRequest(user: AuthUser, orderId: string, input: { paymentId: string; amount: string; reason: string; submissionKey?: string }): Promise<RefundRequestView> {
    if (!REQUESTER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const requestedCents = toCents(input.amount);
    if (!Number.isInteger(requestedCents) || requestedCents <= 0) throw new ApiError("The refund amount must be greater than 0", STATUS_CODES.BAD_REQUEST);
    const reason = input.reason.trim();
    if (!reason) throw new ApiError("A reason is required", STATUS_CODES.BAD_REQUEST);

    return this.runner.$transaction(async (tx) => {
      const scope = await getLeadScope(user, tx);
      const order = await tx.order.findFirst({ where: scopedOrderWhere(orderId, scope), select: { id: true, leadId: true, orderNumber: true } });
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
        select: { id: true, status: true, currency: true, amount: true, refundedAmount: true, externalSource: true, providerPaymentId: true, metadata: true },
      });
      if (!payment) throw new ApiError("That payment does not belong to this order", STATUS_CODES.BAD_REQUEST);

      const ineligible = refundIneligibleReason(payment);
      if (ineligible) throw new ApiError(ineligible, STATUS_CODES.BAD_REQUEST);

      const active = await tx.refundRequest.findMany({ where: { paymentId: payment.id, status: { in: ACTIVE_REFUND_STATUSES } }, select: { amount: true } });
      const calc = getRefundablePaymentAmount(payment, active);
      if (calc.refundableCents <= 0) throw new ApiError("Nothing is left to refund on this payment", STATUS_CODES.BAD_REQUEST);
      if (requestedCents > calc.originalCents) throw new ApiError(`The refund amount can not exceed the payment amount (${money(payment.currency, fromCents(calc.originalCents))})`, STATUS_CODES.BAD_REQUEST);
      if (requestedCents > calc.refundableCents) {
        throw new ApiError(`Only ${money(payment.currency, fromCents(calc.refundableCents))} can still be refunded on this payment (already refunded or held by open refund requests)`, STATUS_CODES.BAD_REQUEST);
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

  async approve(user: AuthUser, id: string, note?: string): Promise<RefundRequestView> {
    return this.decide(user, id, RefundRequestStatus.APPROVED, note ?? null);
  }

  async reject(user: AuthUser, id: string, note: string): Promise<RefundRequestView> {
    if (!note || !note.trim()) throw new ApiError("A rejection reason is required", STATUS_CODES.BAD_REQUEST);
    return this.decide(user, id, RefundRequestStatus.REJECTED, note.trim());
  }

  private async decide(user: AuthUser, id: string, to: "APPROVED" | "REJECTED", note: string | null): Promise<RefundRequestView> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    return this.runner.$transaction(async (tx) => {
      const head = await tx.refundRequest.findUnique({ where: { id }, select: { orderId: true } });
      if (!head) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);
      await advisoryLock(tx, orderLockKey(head.orderId));

      const scope = await getLeadScope(user, tx);
      const found = await tx.refundRequest.findFirst({ where: { id, ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) }, select: { ...REQUEST_SELECT } });
      if (!found) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);

      // Server-side: nobody decides their own request, whatever the UI shows.
      if (found.requestedBy.id === user.id) throw new ApiError("You can not approve or reject your own refund request", STATUS_CODES.FORBIDDEN);
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
          title: to === "APPROVED" ? `Refund of ${amountLabel} approved for order ${order.orderNumber} - not refunded yet` : `Refund of ${amountLabel} rejected for order ${order.orderNumber}`,
          description: note,
          oldValue: { status: RefundRequestStatus.PENDING } as Prisma.InputJsonValue,
          newValue: { status: to, amount: m2(found.amount) } as Prisma.InputJsonValue,
          metadata: { refundRequestId: id, requestedById: found.requestedBy.id, ...(to === "APPROVED" ? { refundExecuted: false } : {}) } as Prisma.InputJsonValue,
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
      const scope = await getLeadScope(user, tx);
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

  /** How many pending requests THIS user could act on (in scope, not their own) - the sidebar badge. */
  async pendingCount(user: AuthUser): Promise<{ count: number }> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    return this.runner.$transaction(async (tx) => {
      const scope = await getLeadScope(user, tx);
      const count = await tx.refundRequest.count({
        where: { status: RefundRequestStatus.PENDING, requestedById: { not: user.id }, ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) },
      });
      return { count };
    });
  }
}

export default RefundsService;
