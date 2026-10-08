// Refund EXECUTION (Phase 1B): sends an APPROVED RefundRequest to Cashfree and brings the result back.
//
//   APPROVED --execute--> executionStatus PROCESSING --provider confirms--> COMPLETED   (Payment accounting applied here, and only here)
//                                     \--provider rejects/cancels--> FAILED               (retryable, always with the SAME refund_id)
//
// Safety properties (financial code - conservative on purpose):
//  - Same three-step shape as payment-link creation: (1) locked transaction decides and marks PROCESSING, (2) the Cashfree call happens with NO
//    transaction open, (3) a second locked transaction records the outcome. The order advisory lock serialises every step per order, so two
//    executions can never both start and two refunds can never spend the same balance. Nothing is process-local.
//  - refund_id is derived from the request id, so every retry reuses it; the request id is also the x-idempotency-key.
//  - A create answer is never treated as completion. Only a Cashfree refund STATUS of SUCCESS (read through get-refund) completes it.
//  - Unknown outcomes (timeout, 5xx, duplicate id) stay PROCESSING and are recovered by reading the refund, never by creating another.
//  - Payment.refundedAmount / refundedAt / status change only on COMPLETED. Order.status is never touched.
//  - Only the sandbox may execute unless CASHFREE_ALLOW_PRODUCTION_REFUNDS=true is set explicitly.
import { prisma } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentStatus, RefundExecutionStatus, RefundRequestStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { CashfreeClient, type CashfreeRefund, type CreateRefundRequest } from "../cashfree/cashfree.client.js";
import { CashfreeConfigError, loadCashfreeConfig, type CashfreeConfig } from "../cashfree/cashfree.config.js";
import { advisoryLock, ProviderHttpError, safeMessage, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { cashfreeOrderIdOf, refundIneligibleReason } from "./refunds.eligibility.js";
import { refundBalance } from "./refunds.balance.js";
import { fetchShopifyRefundable, type ShopifyRefundable } from "./refunds.autoverify.js";
import { OPEN_RESERVATION, REFUND_REFERENCE_TYPE, REQUEST_SELECT, viewsFor } from "./refunds.service.js";
import type { RefundRequestView } from "./refunds.types.js";

const BAD_GATEWAY = 502;
const APPROVER_ROLES = new Set<Role>([Role.MANAGER, Role.ADMIN]);
/** How long a PROCESSING refund that Cashfree has no record of must wait before it may be treated as never created (and so retried). */
export const UNKNOWN_REFUND_GRACE_MS = 2 * 60_000;

export interface RefundApi {
  createRefund(cashfreeOrderId: string, request: CreateRefundRequest, idempotencyKey: string): Promise<CashfreeRefund>;
  getRefund(cashfreeOrderId: string, refundId: string): Promise<CashfreeRefund>;
}

/** The refund_id for a request: "rf" + its uuid without dashes = 34 alphanumeric characters (Cashfree allows 3-40). Stable for the request's life. */
export const refundIdFor = (requestId: string): string => `rf${requestId.replace(/-/g, "")}`;

export type ProviderOutcome = "COMPLETED" | "FAILED" | "PROCESSING";

/** Cashfree refund_status -> CRM execution outcome. Anything not recognised is PROCESSING: never guess a refund into COMPLETED. */
export function mapProviderStatus(status: string | null | undefined): ProviderOutcome {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESS":
      return "COMPLETED";
    case "CANCELLED":
    case "REJECTED":
    case "FAILED":
      return "FAILED";
    default:
      return "PROCESSING"; // PENDING, PENDING_APPROVAL, ONHOLD, unknown
  }
}

/** Sandbox only, unless production refunds were explicitly switched on. Returns the reason to refuse, or null. */
export function refundEnvironmentBlock(config: Pick<CashfreeConfig, "environment">, env: Record<string, string | undefined> = process.env): string | null {
  if (config.environment === "sandbox") return null;
  return (env.CASHFREE_ALLOW_PRODUCTION_REFUNDS ?? "").trim().toLowerCase() === "true" ? null : "Refunds can only be executed against the Cashfree sandbox until production refunds are switched on for this server (set CASHFREE_ALLOW_PRODUCTION_REFUNDS=true). This environment is not the sandbox.";
}

interface OutcomeContext {
  actor?: { id: string; role: Role } | null;
  source: ActivitySource;
  now: Date;
  /** false for the answer to Create Refund: a create answer alone never completes a refund. */
  allowComplete: boolean;
  /** Set when the provider rejected the call outright. */
  failure?: { reason: string; code: string };
  /** The refund webhook: only a refund still PROCESSING is touched, so a repeated delivery (or one for an already failed/finished refund) changes nothing and logs nothing. */
  onlyIfProcessing?: boolean;
}

export type OutcomeResult = { outcome: "completed" | "failed" | "processing" | "unchanged" | "mismatch" };

/**
 * Applies what Cashfree says about a refund to the request (and, once confirmed COMPLETED, to the Payment). Idempotent and lock-protected, so a webhook,
 * a status refresh and a retry can all call it for the same refund without ever counting it twice. The refund webhook (cashfree.webhook.processor.ts) calls exactly this, after re-reading the refund from Cashfree.
 */
export async function applyRefundOutcome(tx: Db, requestId: string, provider: CashfreeRefund | null, ctx: OutcomeContext): Promise<OutcomeResult> {
  const head = await tx.refundRequest.findUnique({ where: { id: requestId }, select: { orderId: true } });
  if (!head) return { outcome: "unchanged" };
  await advisoryLock(tx, orderLockKey(head.orderId));

  const req = await tx.refundRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      id: true, orderId: true, paymentId: true, amount: true, currency: true, status: true, executionStatus: true, refundId: true, cfRefundId: true, providerStatus: true,
      order: { select: { leadId: true, orderNumber: true } },
      payment: { select: { id: true, amount: true, refundedAmount: true, status: true } },
    },
  });
  if (req.status !== RefundRequestStatus.APPROVED || req.executionStatus === RefundExecutionStatus.COMPLETED) return { outcome: "unchanged" };
  if (req.executionStatus === null) return { outcome: "unchanged" }; // execution was never started: nothing to apply
  if (ctx.onlyIfProcessing && req.executionStatus !== RefundExecutionStatus.PROCESSING) return { outcome: "unchanged" };

  const base = { leadId: req.order.leadId, orderId: req.orderId, actorId: ctx.actor?.id ?? null, actorRole: ctx.actor?.role ?? null, source: ctx.source };
  const providerCtx = { provider: "CASHFREE", refundRequestId: req.id, refundId: req.refundId, cfRefundId: provider?.cfRefundId ?? req.cfRefundId, providerStatus: provider?.refundStatus ?? req.providerStatus };
  const fail = async (reason: string, code: string) => {
    await tx.refundRequest.update({ where: { id: req.id }, data: { executionStatus: RefundExecutionStatus.FAILED, failureReason: reason.slice(0, 500), providerErrorCode: code.slice(0, 100), ...(provider ? { providerStatus: provider.refundStatus, cfRefundId: provider.cfRefundId ?? req.cfRefundId } : {}) } });
    await tx.activity.create({
      data: { ...base, type: ActivityType.REFUND_EXECUTION_FAILED, referenceType: REFUND_REFERENCE_TYPE, referenceId: req.id, title: `Refund execution failed for order ${req.order.orderNumber}`, description: reason.slice(0, 500), oldValue: { executionStatus: req.executionStatus } as Prisma.InputJsonValue, newValue: { executionStatus: "FAILED" } as Prisma.InputJsonValue, metadata: { ...providerCtx, code } as Prisma.InputJsonValue },
    });
    return { outcome: "failed" as const };
  };

  if (ctx.failure) return fail(ctx.failure.reason, ctx.failure.code);
  if (!provider) return { outcome: "unchanged" };

  const mapped = mapProviderStatus(provider.refundStatus);
  if (mapped === "FAILED") return fail(`Cashfree reported the refund as ${provider.refundStatus}${provider.statusDescription ? `: ${safeMessage(provider.statusDescription)}` : ""}`, provider.refundStatus);

  const remember = { providerStatus: provider.refundStatus, cfRefundId: provider.cfRefundId ?? req.cfRefundId };
  if (mapped === "PROCESSING" || !ctx.allowComplete) {
    if (remember.providerStatus !== req.providerStatus || remember.cfRefundId !== req.cfRefundId) await tx.refundRequest.update({ where: { id: req.id }, data: remember });
    return { outcome: "processing" };
  }

  // SUCCESS confirmed by Cashfree. The confirmed amount must be exactly what was requested, otherwise a human has to look: stay PROCESSING.
  const requestedCents = toCents(req.amount.toString());
  const confirmedCents = provider.refundAmount !== null ? toCents(provider.refundAmount) : null;
  if (confirmedCents === null || confirmedCents !== requestedCents) {
    await tx.refundRequest.update({ where: { id: req.id }, data: { ...remember, failureReason: `Cashfree confirmed ${provider.refundAmount ?? "an unknown amount"} but ${fromCents(requestedCents)} was requested - needs a manual check` } });
    return { outcome: "mismatch" };
  }
  const paymentCents = toCents(req.payment.amount.toString());
  const alreadyCents = req.payment.refundedAmount ? toCents(req.payment.refundedAmount.toString()) : 0;
  const newRefundedCents = alreadyCents + confirmedCents;
  if (newRefundedCents > paymentCents) {
    await tx.refundRequest.update({ where: { id: req.id }, data: { ...remember, failureReason: "Applying this refund would exceed the payment amount - needs a manual check" } });
    return { outcome: "mismatch" };
  }

  const refundedAt = provider.processedAt && !Number.isNaN(Date.parse(provider.processedAt)) ? new Date(provider.processedAt) : ctx.now;
  const fullyRefunded = newRefundedCents === paymentCents;
  const newStatus = fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;
  await tx.payment.update({ where: { id: req.paymentId }, data: { refundedAmount: fromCents(newRefundedCents), refundedAt, status: newStatus } });
  await tx.refundRequest.update({ where: { id: req.id }, data: { ...remember, executionStatus: RefundExecutionStatus.COMPLETED, executionCompletedAt: ctx.now, failureReason: null, providerErrorCode: null } });
  await tx.activity.createMany({
    data: [
      {
        ...base, type: ActivityType.REFUND_COMPLETED, referenceType: REFUND_REFERENCE_TYPE, referenceId: req.id,
        title: `Refund of ${req.currency === "INR" ? "₹" : `${req.currency} `}${fromCents(confirmedCents)} completed for order ${req.order.orderNumber}`,
        oldValue: { executionStatus: req.executionStatus } as Prisma.InputJsonValue, newValue: { executionStatus: "COMPLETED", amount: fromCents(confirmedCents) } as Prisma.InputJsonValue,
        metadata: { ...providerCtx, refundArn: provider.refundArn } as Prisma.InputJsonValue,
      },
      {
        // The accounting event: a refund that actually happened.
        ...base, type: ActivityType.PAYMENT_REFUNDED, referenceType: "Payment", referenceId: req.paymentId,
        title: `Payment ${fullyRefunded ? "refunded" : "partially refunded"} (Cashfree)`,
        description: `${req.payment.status} -> ${newStatus}`,
        oldValue: { status: req.payment.status, refundedAmount: fromCents(alreadyCents) } as Prisma.InputJsonValue,
        newValue: { status: newStatus, refundedAmount: fromCents(newRefundedCents) } as Prisma.InputJsonValue,
        metadata: { ...providerCtx, refundRequestId: req.id } as Prisma.InputJsonValue,
      },
    ],
  });
  return { outcome: "completed" };
}

export interface ExecutionDeps {
  /** Shopify's CURRENT refundable amount for a Shopify order (by its Shopify order id); read right before a Shopify-originated refund is sent. */
  shopifyRefundable?: (shopifyOrderId: string) => Promise<ShopifyRefundable | null>;
  config?: () => CashfreeConfig;
  client?: (config: CashfreeConfig) => RefundApi;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export interface ExecuteResult {
  request: RefundRequestView;
  /** true only when THIS call sent the refund to Cashfree. */
  sentToProvider: boolean;
}

class RefundExecutionService {
  constructor(
    private readonly runner: TxRunner = prisma,
    private readonly deps: ExecutionDeps = {},
  ) {}

  private config(): CashfreeConfig {
    try {
      return (this.deps.config ?? loadCashfreeConfig)();
    } catch (error) {
      if (error instanceof CashfreeConfigError) throw new ApiError(error.message, STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
  }
  private api(config: CashfreeConfig): RefundApi {
    return this.deps.client ? this.deps.client(config) : new CashfreeClient(config);
  }
  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }
  private guardEnvironment(config: CashfreeConfig): void {
    const blocked = refundEnvironmentBlock(config, this.deps.env);
    if (blocked) throw new ApiError(blocked, STATUS_CODES.FORBIDDEN);
  }

  private async load(tx: Db, _user: AuthUser, id: string) {
    const head = await tx.refundRequest.findUnique({ where: { id }, select: { orderId: true } });
    if (!head) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);
    await advisoryLock(tx, orderLockKey(head.orderId));
    // Executing/checking a refund is manager/admin only and, like approving it, is company-wide (not limited to the approver's own team).
    const scope: Prisma.LeadWhereInput = {};
    const found = await tx.refundRequest.findFirst({
      where: { id, ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) },
      select: {
        ...REQUEST_SELECT,
        payment: { select: { id: true, amount: true, currency: true, refundedAmount: true, method: true, status: true, externalSource: true, provider: true, providerPaymentId: true, metadata: true } },
        order: { select: { orderNumber: true, leadId: true, externalId: true, status: true, metadata: true, lead: { select: { id: true, firstName: true, lastName: true, mobile: true } } } },
      },
    });
    if (!found) throw new ApiError("Refund request not found", STATUS_CODES.NOT_FOUND);
    return found;
  }

  /**
   * A Shopify-originated payment: Shopify's refundable amount is read again RIGHT NOW (read-only), because it can change after the sync (a refund made in Shopify's
   * admin, say). The refund is sent only if Shopify still has room for it, and if Shopify can not be asked nothing is sent. No lock is held across this network
   * call; the amount is checked again under the lock in step 1.
   */
  private async confirmWithShopify(user: AuthUser, id: string): Promise<void> {
    const head = await this.runner.$transaction(async (tx) => {
      const req = await this.load(tx, user, id);
      const startable = req.status === RefundRequestStatus.APPROVED && req.executionStatus !== RefundExecutionStatus.COMPLETED && req.executionStatus !== RefundExecutionStatus.PROCESSING;
      if (req.payment.externalSource !== "SHOPIFY" || !startable || req.requestedBy.id === user.id) return null; // the checks in step 1 deal with those
      const others = await tx.refundRequest.findMany({ where: { paymentId: req.paymentId, id: { not: req.id }, ...OPEN_RESERVATION }, select: { amount: true } });
      return { externalId: req.order.externalId, currency: req.currency, requestedCents: toCents(req.amount.toString()), othersCents: others.reduce((sum, o) => sum + toCents(o.amount.toString()), 0) };
    });
    if (!head) return;

    let live: ShopifyRefundable | null = null;
    try {
      const read = this.deps.shopifyRefundable ?? ((shopifyId: string) => fetchShopifyRefundable(new ShopifyClient(loadShopifyConfig()), `gid://shopify/Order/${shopifyId}`));
      live = head.externalId ? await read(head.externalId) : null;
    } catch {
      live = null;
    }
    if (!live) throw new ApiError("Shopify's current refundable amount could not be confirmed, so nothing was sent to Cashfree. Please try again.", STATUS_CODES.SERVICE_UNAVAILABLE);
    if (live.currency !== head.currency) throw new ApiError("Shopify reports the refundable amount in a different currency than this payment, so nothing was sent to Cashfree.", STATUS_CODES.CONFLICT);
    const room = Math.max(toCents(live.amount) - head.othersCents, 0);
    if (head.requestedCents > room) {
      throw new ApiError(`Shopify now reports only ${head.currency === "INR" ? "₹" : `${head.currency} `}${fromCents(room)} refundable on this order, so this refund was not sent to Cashfree.`, STATUS_CODES.CONFLICT);
    }
  }

  private async view(tx: Db, id: string): Promise<RefundRequestView> {
    return (await viewsFor(tx, [await tx.refundRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT })]))[0]!;
  }

  /** Sends an APPROVED request to Cashfree (once). PROCESSING / COMPLETED requests are returned as they are; FAILED ones are retried with the same refund id. */
  async execute(user: AuthUser, id: string): Promise<ExecuteResult> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const config = this.config();
    this.guardEnvironment(config);
    await this.confirmWithShopify(user, id);

    // ---- step 1 (locked): decide, and mark PROCESSING so nobody else can start it ----
    const prepared = await this.runner.$transaction(async (tx) => {
      const req = await this.load(tx, user, id);
      if (req.requestedBy.id === user.id) throw new ApiError("You can not execute the refund of your own request", STATUS_CODES.FORBIDDEN);
      if (req.status !== RefundRequestStatus.APPROVED) throw new ApiError(`Only an approved refund request can be executed (this one is ${req.status.toLowerCase()})`, STATUS_CODES.CONFLICT);
      if (req.executionStatus === RefundExecutionStatus.COMPLETED) throw new ApiError("This refund has already been completed", STATUS_CODES.CONFLICT);
      if (req.executionStatus === RefundExecutionStatus.PROCESSING) return { start: false as const, view: (await viewsFor(tx, [req]))[0]! };

      // Approval cancels the order, so an approved refund always sits on a cancelled order. If it does not (a legacy approval, or a reactivated order) nothing is sent.
      if (req.order.status !== OrderStatus.CANCELLED) throw new ApiError("This refund was approved but its order is not cancelled, so it was not sent to Cashfree. Cancel the order first.", STATUS_CODES.BAD_REQUEST);
      const ineligible = refundIneligibleReason(req.payment);
      if (ineligible) throw new ApiError(ineligible, STATUS_CODES.BAD_REQUEST);
      const cashfreeOrderId = cashfreeOrderIdOf(req.payment)!;
      const others = await tx.refundRequest.findMany({ where: { paymentId: req.paymentId, id: { not: req.id }, ...OPEN_RESERVATION }, select: { amount: true } });
      const requestedCents = toCents(req.amount.toString());
      // The CRM's balance, and for a Shopify payment never more than Shopify's own remaining refundable amount (unknown = not refundable).
      const balance = refundBalance(req.payment, others, req.order.metadata);
      if (balance.blockedReason) throw new ApiError(balance.blockedReason, STATUS_CODES.BAD_REQUEST);
      if (requestedCents > balance.refundableCents) throw new ApiError("This amount can no longer be refunded on the payment", STATUS_CODES.CONFLICT);

      const refundId = refundIdFor(req.id);
      const now = this.now();
      const { count } = await tx.refundRequest.updateMany({
        where: { id: req.id, status: RefundRequestStatus.APPROVED, OR: [{ executionStatus: null }, { executionStatus: RefundExecutionStatus.FAILED }] },
        data: { executionStatus: RefundExecutionStatus.PROCESSING, refundId, executionStartedAt: now, executedById: user.id, executedByRole: user.role, executionAttempts: { increment: 1 }, failureReason: null, providerErrorCode: null },
      });
      if (count === 0) throw new ApiError("This refund is already being executed", STATUS_CODES.CONFLICT);
      await tx.activity.create({
        data: {
          leadId: req.order.leadId, orderId: req.orderId, actorId: user.id, actorRole: user.role, type: ActivityType.REFUND_EXECUTION_STARTED, referenceType: REFUND_REFERENCE_TYPE, referenceId: req.id, source: ActivitySource.USER,
          title: `Refund of ${req.currency === "INR" ? "₹" : `${req.currency} `}${fromCents(requestedCents)} sent to Cashfree for order ${req.order.orderNumber}`,
          oldValue: { executionStatus: req.executionStatus } as Prisma.InputJsonValue, newValue: { executionStatus: "PROCESSING" } as Prisma.InputJsonValue,
          metadata: { provider: "CASHFREE", environment: config.environment, refundRequestId: req.id, refundId, attempt: (await tx.refundRequest.findUniqueOrThrow({ where: { id: req.id }, select: { executionAttempts: true } })).executionAttempts } as Prisma.InputJsonValue,
        },
      });
      return { start: true as const, cashfreeOrderId, refundId, requestId: req.id, amountCents: requestedCents, orderNumber: req.order.orderNumber };
    });
    if (!prepared.start) return { request: prepared.view, sentToProvider: false };

    // ---- step 2 (NO transaction open): the one Cashfree call ----
    const api = this.api(config);
    const body: CreateRefundRequest = { refund_amount: prepared.amountCents / 100, refund_id: prepared.refundId, refund_note: `CRM refund ${prepared.orderNumber}`.slice(0, 100).padEnd(3, "."), refund_speed: "STANDARD" };
    const ctx = { actor: { id: user.id, role: user.role }, source: ActivitySource.USER, now: this.now() };
    let created: CashfreeRefund | null = null;
    let failure: { reason: string; code: string } | undefined;
    let recover = false;
    try {
      created = await api.createRefund(prepared.cashfreeOrderId, body, prepared.requestId);
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        // 409 = this refund_id already exists at Cashfree (an earlier attempt got through); a timeout / 5xx / 429 = we do not know. Neither is a failure.
        if (error.status === 409 || error.retryable) recover = true;
        else failure = { reason: `Cashfree rejected the refund: ${error.message}`, code: `HTTP_${error.status ?? "ERR"}` };
      } else {
        recover = true; // an unreadable answer: the refund may exist - find out, do not retry blindly
      }
    }

    // ---- step 3: read back what happened where we do not know, then record under the lock ----
    let known: CashfreeRefund | null = created;
    if (recover && !known) {
      try {
        known = await api.getRefund(prepared.cashfreeOrderId, prepared.refundId);
      } catch {
        known = null; // still unknown: stays PROCESSING and a status refresh recovers it
      }
    }
    await this.runner.$transaction((tx) => applyRefundOutcome(tx, prepared.requestId, known, { ...ctx, allowComplete: created === null && known !== null, failure }));
    return { request: await this.runner.$transaction((tx) => this.view(tx, prepared.requestId)), sentToProvider: true };
  }

  /** Reads the refund from Cashfree (read-only) and applies it: this is what confirms COMPLETED (or FAILED) for a PROCESSING refund. */
  async refresh(user: AuthUser, id: string): Promise<RefundRequestView> {
    if (!APPROVER_ROLES.has(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
    const config = this.config();
    this.guardEnvironment(config);
    const req = await this.runner.$transaction(async (tx) => {
      const r = await this.load(tx, user, id);
      return { ...r, view: (await viewsFor(tx, [r]))[0]! };
    });
    if (req.status !== RefundRequestStatus.APPROVED || req.executionStatus === null) throw new ApiError("This refund has not been sent to Cashfree", STATUS_CODES.CONFLICT);
    if (req.executionStatus !== RefundExecutionStatus.PROCESSING) return req.view;

    const cashfreeOrderId = cashfreeOrderIdOf(req.payment);
    if (!cashfreeOrderId || !req.refundId) throw new ApiError("The Cashfree identifiers of this refund are missing", STATUS_CODES.CONFLICT);
    let refund: CashfreeRefund | null = null;
    let notFound = false;
    try {
      refund = await this.api(config).getRefund(cashfreeOrderId, req.refundId);
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status === 404) notFound = true;
      else throw new ApiError(error instanceof ProviderHttpError ? `Cashfree did not return the refund: ${error.message}` : "Cashfree returned an unexpected answer", BAD_GATEWAY);
    }
    const ctx = { actor: { id: user.id, role: user.role }, source: ActivitySource.USER, now: this.now(), allowComplete: true };
    // Cashfree has no record of it. Only after a grace period, and only when no provider id was ever recorded, is it safe to call it never created
    // (FAILED, retryable with the SAME refund_id); before that the create call may still be in flight.
    const stale = notFound && !req.cfRefundId && req.executionStartedAt !== null && this.now().getTime() - req.executionStartedAt.getTime() > UNKNOWN_REFUND_GRACE_MS;
    await this.runner.$transaction((tx) => applyRefundOutcome(tx, id, refund, stale ? { ...ctx, failure: { reason: "Cashfree has no record of this refund; it can be retried", code: "NOT_FOUND_AT_PROVIDER" } } : ctx));
    return this.runner.$transaction((tx) => this.view(tx, id));
  }
}

export default RefundExecutionService;
