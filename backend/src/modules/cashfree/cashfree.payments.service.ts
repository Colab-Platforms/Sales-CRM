import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { computePaymentBreakdown, fullName, scopedOrderWhere } from "../orders/orders.filters.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import WhatsAppMessagingService from "../whatsapp/whatsapp.messaging.service.js";
import type { WhatsAppMessageSummary } from "../whatsapp/whatsapp.types.js";
import { advisoryLock, asRecord, ProviderHttpError, toTenDigitMobile, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { applyPaymentUpdate, linkToUpdate, orderLockKey, PAYMENT_REFERENCE_TYPE } from "./cashfree.apply.js";
import { CashfreeClient, type CashfreeLink, type CreateLinkRequest } from "./cashfree.client.js";
import { CashfreeConfigError, isCashfreeEnabled, loadCashfreeConfig, type CashfreeConfig } from "./cashfree.config.js";

// Creates and manages Cashfree payment links for an existing CRM order. The order is the business reference: no Shopify
// order is ever created, and the Payment row this makes is the same row the webhook later updates, so reconciliation
// (which sums Payment rows) sees one payment, never two.

export interface CashfreeApi {
  createLink(request: CreateLinkRequest, idempotencyKey: string): Promise<CashfreeLink>;
  getLink(linkId: string): Promise<CashfreeLink>;
  cancelLink(linkId: string): Promise<CashfreeLink | null>;
}

export interface PaymentLinkResult {
  paymentId: string;
  orderId: string;
  linkId: string;
  amount: string;
  currency: string;
  status: PaymentStatus;
  paymentUrl: string | null;
  expiresAt: Date | null;
  /** true when an existing open link for the same amount was returned instead of creating another. */
  reused: boolean;
  /** false when PUBLIC_BACKEND_URL is not a public https URL: the link works, but its status only updates via refresh. */
  webhookRegistered: boolean;
}

export interface ServiceDeps {
  config?: () => CashfreeConfig;
  client?: (config: CashfreeConfig) => CashfreeApi;
  messaging?: () => Pick<WhatsAppMessagingService, "sendTemplate">;
  now?: () => Date;
}

const BLOCKED_ORDER_STATUSES = new Set<OrderStatus>([OrderStatus.CANCELLED, OrderStatus.REFUNDED, OrderStatus.RETURNED]);
const OPEN = new Set<PaymentStatus>([PaymentStatus.PENDING, PaymentStatus.PROCESSING]);
const BAD_GATEWAY = 502;

/** Cashfree wants a 10-digit Indian mobile number. */
export const toCashfreePhone = toTenDigitMobile;

/** The link id doubles as the payment's externalId, so it is derived from the payment id: unique, and stable across retries. */
export const linkIdFor = (paymentId: string) => `crm_${paymentId.replace(/-/g, "")}`;

/** ISO 8601 with an explicit offset and no milliseconds, which is what Cashfree's docs show for link_expiry_time. */
export const formatExpiry = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "+00:00");

const PAYMENT_SELECT = {
  id: true,
  orderId: true,
  status: true,
  amount: true,
  currency: true,
  externalSource: true,
  externalId: true,
  paymentUrl: true,
  paymentExpiresAt: true,
  order: { select: { id: true, leadId: true, orderNumber: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

class CashfreePaymentsService {
  constructor(
    private readonly runner: TxRunner = prisma,
    private readonly deps: ServiceDeps = {},
  ) {}

  private config(): CashfreeConfig {
    try {
      return (this.deps.config ?? loadCashfreeConfig)();
    } catch (error) {
      if (error instanceof CashfreeConfigError) throw new ApiError(error.message, STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
  }

  private api(config: CashfreeConfig): CashfreeApi {
    return this.deps.client ? this.deps.client(config) : new CashfreeClient(config);
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Whether Cashfree is switched on and complete - never returns credentials. */
  status(): { enabled: boolean; configured: boolean; environment: string | null; webhookRegistered: boolean } {
    if (!isCashfreeEnabled()) return { enabled: false, configured: false, environment: null, webhookRegistered: false };
    try {
      const config = this.config();
      return { enabled: true, configured: true, environment: config.environment, webhookRegistered: config.notifyUrl !== null };
    } catch {
      return { enabled: true, configured: false, environment: null, webhookRegistered: false };
    }
  }

  // ---------------------------------------------------------------- create

  async createPaymentLink(user: AuthUser, orderId: string): Promise<PaymentLinkResult> {
    const config = this.config();
    const prepared = await this.runner.$transaction((tx) => this.prepare(tx, user, orderId, config));

    if (prepared.needsProvider) {
      const link = await this.createOrRecover(config, prepared.request, prepared.paymentId, prepared.linkId);
      await this.runner.$transaction((tx) => this.finish(tx, user, prepared, link));
    }

    return this.runner.$transaction(async (tx) => {
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: prepared.paymentId }, select: PAYMENT_SELECT });
      return this.toResult(payment, prepared.reused, config);
    });
  }

  /** Phase 1 (locked): decide whether there is anything to pay and which row represents it. Nothing is sent to Cashfree here. */
  private async prepare(tx: Db, user: AuthUser, orderId: string, config: CashfreeConfig) {
    await advisoryLock(tx, orderLockKey(orderId));
    const now = this.now();
    const scope = await getLeadScope(user, tx);
    const order = await tx.order.findFirst({
      where: scopedOrderWhere(orderId, scope),
      select: {
        id: true,
        orderNumber: true,
        status: true,
        currency: true,
        totalAmount: true,
        lead: { select: { id: true, firstName: true, lastName: true, normalizedMobile: true, email: true } },
        payments: { select: { id: true, status: true, amount: true, refundedAmount: true, externalSource: true, paymentUrl: true, paymentExpiresAt: true } },
      },
    });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    if (BLOCKED_ORDER_STATUSES.has(order.status)) throw new ApiError(`A payment link can not be created for a ${order.status.toLowerCase()} order`, STATUS_CODES.BAD_REQUEST);

    // Links that lapsed while nobody was looking are closed first, so they never block a new one.
    for (const p of order.payments) {
      if (p.externalSource === "CASHFREE" && OPEN.has(p.status) && p.paymentExpiresAt && p.paymentExpiresAt <= now) {
        await applyPaymentUpdate(tx, p.id, { status: "FAILED", failureReason: "Payment link expired" }, { source: ActivitySource.SYSTEM, now });
        p.status = PaymentStatus.FAILED;
      }
    }

    // The exact pending amount, by the same rule reconciliation uses for "outstanding".
    const breakdown = computePaymentBreakdown(order.payments);
    const outstandingCents = Math.max(toCents(order.totalAmount.toString()) - breakdown.paidCents - breakdown.refundedCents, 0);
    if (outstandingCents === 0) throw new ApiError("This order has no pending amount to collect", STATUS_CODES.BAD_REQUEST);

    const open = order.payments.find((p) => p.externalSource === "CASHFREE" && OPEN.has(p.status));
    if (open) {
      if (toCents(open.amount.toString()) !== outstandingCents) {
        throw new ApiError("An open payment link exists for a different amount. Cancel it before creating a new one.", STATUS_CODES.CONFLICT);
      }
      const request = open.paymentUrl ? null : this.buildRequest(order, open.id, outstandingCents, config, now);
      return { paymentId: open.id, linkId: linkIdFor(open.id), reused: true, needsProvider: !open.paymentUrl, request: request as CreateLinkRequest, orderNumber: order.orderNumber, leadId: order.lead.id, expiresAt: request ? new Date(request.link_expiry_time) : null };
    }

    const paymentId = randomUUID();
    const request = this.buildRequest(order, paymentId, outstandingCents, config, now);
    const expiresAt = new Date(now.getTime() + config.linkExpiryHours * 3_600_000);
    await tx.payment.create({
      data: {
        id: paymentId,
        orderId: order.id,
        provider: "Cashfree",
        providerOrderId: linkIdFor(paymentId),
        amount: fromCents(outstandingCents),
        currency: order.currency,
        method: PaymentMethod.PAYMENT_LINK,
        status: PaymentStatus.PENDING,
        externalSource: "CASHFREE",
        externalId: linkIdFor(paymentId),
        paymentExpiresAt: expiresAt,
      },
    });
    return { paymentId, linkId: linkIdFor(paymentId), reused: false, needsProvider: true, request, orderNumber: order.orderNumber, leadId: order.lead.id, expiresAt };
  }

  private buildRequest(
    order: { orderNumber: string; currency: string; lead: { firstName: string; lastName: string | null; normalizedMobile: string | null; email: string | null } },
    paymentId: string,
    cents: number,
    config: CashfreeConfig,
    now: Date,
  ): CreateLinkRequest {
    const phone = toCashfreePhone(order.lead.normalizedMobile);
    if (!phone) throw new ApiError("This customer has no valid 10-digit mobile number, which Cashfree requires for a payment link", STATUS_CODES.BAD_REQUEST);
    return {
      link_id: linkIdFor(paymentId),
      link_amount: cents / 100,
      link_currency: order.currency,
      link_purpose: `Payment for order ${order.orderNumber}`.slice(0, 500),
      customer_details: {
        customer_phone: phone,
        customer_name: fullName(order.lead.firstName, order.lead.lastName).slice(0, 100),
        ...(order.lead.email ? { customer_email: order.lead.email } : {}),
      },
      link_partial_payments: false,
      link_expiry_time: formatExpiry(new Date(now.getTime() + config.linkExpiryHours * 3_600_000)),
      link_notify: { send_sms: false, send_email: false },
      link_auto_reminders: false,
      ...(config.notifyUrl || config.returnUrl ? { link_meta: { ...(config.notifyUrl ? { notify_url: config.notifyUrl } : {}), ...(config.returnUrl ? { return_url: config.returnUrl } : {}) } } : {}),
      link_notes: { crm_payment: paymentId, crm_order: order.orderNumber.slice(0, 100) },
    };
  }

  /** Phase 2 (no transaction held open): the call to Cashfree, made safe to repeat by a deterministic link id and idempotency key. */
  private async createOrRecover(config: CashfreeConfig, request: CreateLinkRequest, paymentId: string, linkId: string): Promise<CashfreeLink> {
    const api = this.api(config);
    try {
      return await api.createLink(request, paymentId);
    } catch (error) {
      if (error instanceof ProviderHttpError) {
        // 409: Cashfree already has this link id, i.e. an earlier attempt got through. Read it instead of failing.
        if (error.status === 409) {
          try {
            return await api.getLink(linkId);
          } catch {
            /* fall through to the generic failure below */
          }
        }
        if (!error.retryable) await this.markCreationFailed(paymentId, error.message);
        throw new ApiError(error.retryable ? "Cashfree could not be reached. Nothing was lost - try again in a moment." : `Cashfree rejected the payment link: ${error.message}`, BAD_GATEWAY);
      }
      throw new ApiError("Cashfree returned an unexpected answer. Nothing was charged - try again.", BAD_GATEWAY);
    }
  }

  private async markCreationFailed(paymentId: string, reason: string): Promise<void> {
    await this.runner.$transaction((tx) => applyPaymentUpdate(tx, paymentId, { status: "FAILED", failureReason: `Cashfree rejected the link: ${reason}` }, { source: ActivitySource.SYSTEM, now: this.now() }));
  }

  /** Phase 3 (locked): store the link on the payment and record it in the audit trail, once. */
  private async finish(tx: Db, user: AuthUser, prepared: { paymentId: string; linkId: string; orderNumber: string; leadId: string; expiresAt: Date | null }, link: CashfreeLink) {
    await advisoryLock(tx, orderLockKey((await tx.payment.findUniqueOrThrow({ where: { id: prepared.paymentId }, select: { orderId: true } })).orderId));
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: prepared.paymentId }, select: { orderId: true, paymentUrl: true, metadata: true } });
    if (payment.paymentUrl) return; // a concurrent retry already stored it
    const expiry = link.linkExpiryTime ? new Date(link.linkExpiryTime) : prepared.expiresAt;
    await tx.payment.update({
      where: { id: prepared.paymentId },
      data: {
        paymentUrl: link.linkUrl,
        paymentExpiresAt: expiry && !Number.isNaN(expiry.getTime()) ? expiry : prepared.expiresAt,
        metadata: { ...asRecord(payment.metadata), cashfree: { cfLinkId: link.cfLinkId, linkStatus: link.linkStatus } } as Prisma.InputJsonValue,
      },
    });
    await tx.activity.create({
      data: {
        leadId: prepared.leadId,
        orderId: payment.orderId,
        actorId: user.id,
        actorRole: user.role,
        type: ActivityType.PAYMENT_LINK_CREATED,
        referenceType: PAYMENT_REFERENCE_TYPE,
        referenceId: prepared.paymentId,
        source: ActivitySource.USER,
        title: `Cashfree payment link created for order ${prepared.orderNumber}`,
        newValue: { linkId: prepared.linkId, status: PaymentStatus.PENDING },
        // The link URL itself is deliberately not written to the audit trail.
        metadata: { provider: "CASHFREE", linkId: prepared.linkId },
      },
    });
  }

  private toResult(payment: PaymentRow, reused: boolean, config: CashfreeConfig): PaymentLinkResult {
    return {
      paymentId: payment.id,
      orderId: payment.orderId,
      linkId: payment.externalId ?? linkIdFor(payment.id),
      // Always two decimals ("449.00"): Prisma drops trailing zeros, and this is money shown to people.
      amount: fromCents(toCents(payment.amount.toString())),
      currency: payment.currency,
      status: payment.status,
      paymentUrl: payment.paymentUrl,
      expiresAt: payment.paymentExpiresAt,
      reused,
      webhookRegistered: config.notifyUrl !== null,
    };
  }

  // ---------------------------------------------------------------- cancel / refresh

  private async loadPayment(tx: Db, user: AuthUser, paymentId: string): Promise<PaymentRow> {
    const scope = await getLeadScope(user, tx);
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, externalSource: "CASHFREE", ...(Object.keys(scope).length > 0 ? { order: { lead: scope } } : {}) },
      select: PAYMENT_SELECT,
    });
    if (!payment) throw new ApiError("Payment not found", STATUS_CODES.NOT_FOUND);
    return payment;
  }

  async cancelPaymentLink(user: AuthUser, paymentId: string): Promise<PaymentLinkResult> {
    const config = this.config();
    const payment = await this.runner.$transaction((tx) => this.loadPayment(tx, user, paymentId));
    if (!OPEN.has(payment.status)) throw new ApiError(`This payment is already ${payment.status.toLowerCase()} and its link can not be cancelled`, STATUS_CODES.CONFLICT);
    const linkId = payment.externalId ?? linkIdFor(payment.id);

    try {
      await this.api(config).cancelLink(linkId);
    } catch (error) {
      if (error instanceof ProviderHttpError && !error.retryable) {
        // Most likely the link was paid or expired in the meantime; bring the CRM in line with what Cashfree says.
        await this.refreshPaymentLink(user, paymentId).catch(() => undefined);
        throw new ApiError(`Cashfree would not cancel the link: ${error.message}. Its status has been refreshed.`, STATUS_CODES.CONFLICT);
      }
      throw new ApiError("Cashfree could not be reached, so the link was not cancelled. Try again.", BAD_GATEWAY);
    }

    return this.runner.$transaction(async (tx) => {
      await applyPaymentUpdate(
        tx,
        paymentId,
        { status: "FAILED", failureReason: "Payment link cancelled", meta: { linkStatus: "CANCELLED" }, activity: { type: ActivityType.PAYMENT_LINK_CANCELLED, title: `Cashfree payment link cancelled` } },
        { source: ActivitySource.USER, actor: user, now: this.now() },
      );
      return this.toResult(await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: PAYMENT_SELECT }), false, config);
    });
  }

  /** Reads the link from Cashfree and brings the CRM payment in line with it. The webhook does the same automatically. */
  async refreshPaymentLink(user: AuthUser, paymentId: string): Promise<PaymentLinkResult> {
    const config = this.config();
    const payment = await this.runner.$transaction((tx) => this.loadPayment(tx, user, paymentId));
    const linkId = payment.externalId ?? linkIdFor(payment.id);

    let link: CashfreeLink;
    try {
      link = await this.api(config).getLink(linkId);
    } catch (error) {
      throw new ApiError(error instanceof ProviderHttpError ? `Cashfree did not return the link: ${error.message}` : "Cashfree returned an unexpected answer", BAD_GATEWAY);
    }

    return this.runner.$transaction(async (tx) => {
      await applyPaymentUpdate(tx, paymentId, linkToUpdate(link), { source: ActivitySource.USER, actor: user, now: this.now() });
      return this.toResult(await tx.payment.findUniqueOrThrow({ where: { id: paymentId }, select: PAYMENT_SELECT }), false, config);
    });
  }

  // ---------------------------------------------------------------- WhatsApp

  /**
   * Sends the payment link to the customer through the existing E7.3 template messaging - no second sender. The template
   * must contain {{payment_link}}; the variable resolver fills it from this order's open Cashfree payment.
   */
  async sendPaymentLinkWhatsApp(user: AuthUser, paymentId: string, templateId: string): Promise<WhatsAppMessageSummary> {
    const payment = await this.runner.$transaction(async (tx) => {
      const found = await this.loadPayment(tx, user, paymentId);
      const template = await tx.whatsAppTemplate.findUnique({ where: { id: templateId }, select: { variables: true } });
      if (!template) throw new ApiError("Template not found", STATUS_CODES.NOT_FOUND);
      const variables = Array.isArray(template.variables) ? (template.variables as string[]) : [];
      if (!variables.includes("payment_link")) throw new ApiError("This template does not contain a {{payment_link}} placeholder, so it would not deliver the payment link", STATUS_CODES.BAD_REQUEST);
      return found;
    });

    if (!OPEN.has(payment.status) || !payment.paymentUrl) throw new ApiError("There is no open payment link to send for this payment", STATUS_CODES.CONFLICT);
    if (payment.paymentExpiresAt && payment.paymentExpiresAt <= this.now()) throw new ApiError("This payment link has expired. Create a new one.", STATUS_CODES.CONFLICT);

    const messaging = this.deps.messaging ? this.deps.messaging() : new WhatsAppMessagingService();
    return messaging.sendTemplate(user, { leadId: payment.order.leadId, templateId, orderId: payment.orderId });
  }
}

export default CashfreePaymentsService;
