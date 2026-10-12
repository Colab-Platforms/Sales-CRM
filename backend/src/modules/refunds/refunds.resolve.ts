// Looks up (and VERIFIES) the Cashfree references of a Shopify-synced Cashfree payment, so it can be refunded like a CRM-created one. READ-ONLY toward
// Shopify and Cashfree: one Shopify transaction read, one Cashfree "payments of an order" read. Nothing is created, paid or refunded here.
//
// Where the references come from (checked against a real Shopify + Fastrr/Cashfree order): the Shopify transaction's receipt carries the Cashfree payment id
// (receiptJson.payment_id, repeated in the order's "Cashfree_txn_id" attribute) and its authorization code is Cashfree's own order id. The Shopify
// transaction id the CRM stores as the payment reference (e.g. 20808276639933) and Shopify's payment id ("#AWL101729.1") are Shopify's and are NEVER sent to
// Cashfree. Nothing is trusted on its own: the claimed order must exist at the Cashfree account/environment the CRM is connected to, must list EXACTLY ONE
// successful payment whose cf_payment_id equals the receipt's, for exactly this payment's amount. A live Shopify payment is never looked up against the
// sandbox (and a test one never against production). Anything else leaves the payment unresolved (and so not refundable) - a wrong guess could refund the wrong
// customer's money, so there is no "close enough".
import { prisma } from "@/lib/prisma.js";
import { getLeadScope } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { CashfreeClient, type CashfreeOrderPayment } from "../cashfree/cashfree.client.js";
import { CashfreeConfigError, loadCashfreeConfig, type CashfreeConfig } from "../cashfree/cashfree.config.js";
import { advisoryLock, asRecord, ProviderHttpError, type Db, type TxRunner } from "../integrations/integrations.common.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { toCents } from "../shopify/shopify.money.js";
import { scopedOrderWhere } from "../orders/orders.filters.js";
import { canResolveCashfreeIds, cashfreeOrderIdOf, cashfreePaymentIdOf, refundIneligibleReason } from "./refunds.eligibility.js";

/** What Shopify says about the payment's gateway transaction. */
export interface ShopifyReceipt {
  gateway: string | null;
  /** The gateway's own payment id from the receipt (receiptJson.payment_id): the Cashfree cf_payment_id, to be verified. */
  receiptPaymentId: string | null;
  /** Shopify's authorization code for the transaction: Cashfree's order_id, to be verified. */
  authorizationCode: string | null;
  kind: string | null;
  status: string | null;
  /** Shopify's own flag: true for a test-mode transaction, false for a live one, null when Shopify did not say. */
  test: boolean | null;
  /** The order's "Cashfree_txn_id" attribute (set by the checkout app), when present. A second, independent statement of the cf_payment_id. */
  cashfreeTxnId: string | null;
}

export interface ShopifyReceiptLookup {
  getTransactionReceipt(transactionId: string): Promise<ShopifyReceipt | null>;
}
export interface CashfreePaymentsLookup {
  getOrderPayments(cashfreeOrderId: string): Promise<CashfreeOrderPayment[]>;
}

const RECEIPT_QUERY = `query($id: ID!) { node(id: $id) { ... on OrderTransaction { kind status gateway authorizationCode test receiptJson order { customAttributes { key value } } } } }`;

export class ShopifyReceiptReader implements ShopifyReceiptLookup {
  constructor(private readonly client: Pick<ShopifyClient, "query">) {}
  async getTransactionReceipt(transactionId: string): Promise<ShopifyReceipt | null> {
    const data = await this.client.query<{ node: Record<string, unknown> | null }>(RECEIPT_QUERY, { id: `gid://shopify/OrderTransaction/${transactionId}` });
    const node = data.node;
    if (!node) return null;
    let receipt: Record<string, unknown> = {};
    try {
      receipt = asRecord(JSON.parse(typeof node.receiptJson === "string" ? node.receiptJson : "{}"));
    } catch {
      receipt = {};
    }
    const text = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null);
    const attributes = asRecord(node.order).customAttributes;
    const txnAttribute = Array.isArray(attributes) ? attributes.map(asRecord).find((a) => a.key === "Cashfree_txn_id") : undefined;
    return {
      gateway: text(node.gateway),
      receiptPaymentId: text(receipt.payment_id),
      authorizationCode: text(node.authorizationCode),
      kind: text(node.kind),
      status: text(node.status),
      test: typeof node.test === "boolean" ? node.test : null,
      cashfreeTxnId: text(txnAttribute?.value),
    };
  }
}

export interface ResolveResult {
  resolved: boolean;
  /** Why not (null when resolved). Never contains credentials. */
  reason: string | null;
  cashfreeOrderId: string | null;
  cfPaymentId: string | null;
}

/**
 * A live Shopify payment exists only in LIVE Cashfree and a test one only in the sandbox, so asking the other environment can never find it. Decided before
 * anything is sent to Cashfree, from Shopify's own test flag; null when there is no conflict (or Shopify did not say).
 */
export function environmentMismatch(receipt: Pick<ShopifyReceipt, "test"> | null, environment: string): string | null {
  if (!receipt || receipt.test === null) return null;
  if (receipt.test === false && environment === "sandbox") return "This is a live payment, but the CRM is connected to the Cashfree sandbox, so it cannot be verified here. Connect the CRM to the Cashfree account that collected the payment.";
  if (receipt.test === true && environment === "production") return "Shopify marks this as a test payment, but the CRM is connected to live Cashfree, so it cannot be verified here.";
  return null;
}

/** Pure decision: do the Shopify receipt and Cashfree's own records agree on one payment of this amount? */
export function verifyShopifyCashfreeIds(receipt: ShopifyReceipt | null, paymentAmount: string, cashfreePayments: CashfreeOrderPayment[] | null, context: { environment?: string } = {}): ResolveResult {
  const no = (reason: string): ResolveResult => ({ resolved: false, reason, cashfreeOrderId: null, cfPaymentId: null });
  if (!receipt) return no("Shopify has no record of this transaction");
  if (!/cashfree/i.test(receipt.gateway ?? "")) return no("The Shopify transaction was not made through Cashfree");
  if (receipt.kind && !["SALE", "CAPTURE"].includes(receipt.kind.toUpperCase())) return no("The Shopify transaction is not a sale");
  if (receipt.status && receipt.status.toUpperCase() !== "SUCCESS") return no("The Shopify transaction was not successful");
  if (!receipt.receiptPaymentId || !receipt.authorizationCode) return no("The Shopify receipt does not carry the Cashfree references");
  // Shopify's own records must agree with each other: the receipt and the checkout app's attribute name the same Cashfree payment (when the attribute exists).
  if (receipt.cashfreeTxnId && receipt.cashfreeTxnId !== receipt.receiptPaymentId) return no("Shopify's own records disagree about the Cashfree payment id");
  if (cashfreePayments === null) {
    const where = context.environment ? ` (${context.environment})` : "";
    return no(`Cashfree${where} has no order with the reference from Shopify (${receipt.authorizationCode}). The CRM must be connected to the same Cashfree account and environment that collected the payment`);
  }
  const successful = new Map<string, CashfreeOrderPayment>();
  for (const p of cashfreePayments) if (p.paymentStatus === "SUCCESS" && !successful.has(p.cfPaymentId)) successful.set(p.cfPaymentId, p);
  if (successful.size !== 1) return no(successful.size === 0 ? "Cashfree shows no successful payment on that order" : "Cashfree shows several different successful payments on that order");
  const only = [...successful.values()][0]!;
  if (only.cfPaymentId !== receipt.receiptPaymentId) return no("The Cashfree payment does not match the one in the Shopify receipt");
  if (only.paymentAmount === null || toCents(only.paymentAmount) !== toCents(paymentAmount)) return no("The Cashfree payment amount does not match this payment");
  return { resolved: true, reason: null, cashfreeOrderId: receipt.authorizationCode, cfPaymentId: only.cfPaymentId };
}

export interface ResolveDeps {
  shopify?: () => ShopifyReceiptLookup;
  cashfreeConfig?: () => CashfreeConfig;
  cashfree?: (config: CashfreeConfig) => CashfreePaymentsLookup;
  now?: () => Date;
}

class CashfreeIdResolutionService {
  constructor(
    private readonly runner: TxRunner = prisma,
    private readonly deps: ResolveDeps = {},
  ) {}

  private async loadPayment(tx: Db, user: AuthUser | null, orderId: string, paymentId: string) {
    // user === null is the system itself (automatic verification right after a Shopify sync), which has no lead scope.
    const scope = user ? await getLeadScope(user, tx) : {};
    const order = await tx.order.findFirst({ where: scopedOrderWhere(orderId, scope), select: { id: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    const payment = await tx.payment.findFirst({
      where: { id: paymentId, orderId: order.id },
      select: { id: true, orderId: true, amount: true, status: true, method: true, provider: true, externalSource: true, externalId: true, providerPaymentId: true, metadata: true },
    });
    if (!payment) throw new ApiError("That payment does not belong to this order", STATUS_CODES.BAD_REQUEST);
    return payment;
  }

  /** Re-runs the verification for one payment (the optional "retry" when the automatic one after the sync did not succeed). Records the ids only if everything agrees. */
  async resolve(user: AuthUser, orderId: string, paymentId: string): Promise<ResolveResult> {
    return this.run(user, orderId, paymentId);
  }

  /**
   * The verification that runs automatically after a Shopify sync. No user; never throws because of a problem with the payment or the providers - the outcome
   * (verified, or why not) is recorded on the payment instead, so the order page can explain it. A database failure still propagates.
   */
  async resolveAutomatically(orderId: string, paymentId: string): Promise<ResolveResult> {
    try {
      return await this.run(null, orderId, paymentId);
    } catch (error) {
      const reason = error instanceof ApiError ? error.message : "The payment could not be verified";
      await this.record({ id: paymentId, orderId }, { status: "FAILED", reason });
      return { resolved: false, reason, cashfreeOrderId: null, cfPaymentId: null };
    }
  }

  /** Writes the outcome of the latest verification next to (never over) the verified Cashfree references. */
  private async record(payment: { id: string; orderId: string }, outcome: { status: "FAILED" | "VERIFIED"; reason?: string | null }): Promise<void> {
    const checkedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    await this.runner.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(payment.orderId));
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { metadata: true } });
      const meta = asRecord(fresh.metadata);
      const cashfreeVerification = { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason.slice(0, 500) } : {}), checkedAt };
      await tx.payment.update({ where: { id: payment.id }, data: { metadata: { ...meta, cashfreeVerification } as Prisma.InputJsonValue } });
    });
  }

  private async run(user: AuthUser | null, orderId: string, paymentId: string): Promise<ResolveResult> {
    const payment = await this.runner.$transaction((tx) => this.loadPayment(tx, user, orderId, paymentId));
    if (cashfreeOrderIdOf(payment) && cashfreePaymentIdOf(payment)) return { resolved: true, reason: null, cashfreeOrderId: cashfreeOrderIdOf(payment), cfPaymentId: cashfreePaymentIdOf(payment) };
    if (!canResolveCashfreeIds(payment)) throw new ApiError(refundIneligibleReason(payment) ?? "The Cashfree references of this payment cannot be looked up", STATUS_CODES.BAD_REQUEST);
    if (!payment.externalId) throw new ApiError("This payment has no Shopify transaction reference", STATUS_CODES.BAD_REQUEST);

    let receipt: ShopifyReceipt | null;
    try {
      receipt = await (this.deps.shopify ? this.deps.shopify() : new ShopifyReceiptReader(new ShopifyClient(loadShopifyConfig()))).getTransactionReceipt(payment.externalId);
    } catch (error) {
      if (error instanceof ShopifyConfigError) throw new ApiError("Shopify is not available, so the payment could not be looked up", STATUS_CODES.SERVICE_UNAVAILABLE);
      throw new ApiError("Shopify could not be reached. Nothing was changed - try again.", 502);
    }

    let cashfreePayments: CashfreeOrderPayment[] | null = null;
    let cashfreeEnvironment: string | undefined;
    let mismatch: string | null = null;
    if (receipt?.authorizationCode) {
      try {
        const config = this.deps.cashfreeConfig ? this.deps.cashfreeConfig() : loadCashfreeConfig();
        cashfreeEnvironment = config.environment;
        // A live payment is never looked up against the sandbox (or a test one against production): it can only come back "no such order".
        mismatch = environmentMismatch(receipt, config.environment);
        if (!mismatch) cashfreePayments = await (this.deps.cashfree ? this.deps.cashfree(config) : new CashfreeClient(config)).getOrderPayments(receipt.authorizationCode);
      } catch (error) {
        if (error instanceof CashfreeConfigError) throw new ApiError(error.message, STATUS_CODES.SERVICE_UNAVAILABLE);
        if (!(error instanceof ProviderHttpError && (error.status === 404 || error.status === 400))) throw new ApiError("Cashfree could not be reached. Nothing was changed - try again.", 502);
        cashfreePayments = null; // Cashfree answered "no such order"
      }
    }

    if (mismatch) {
      await this.record(payment, { status: "FAILED", reason: mismatch });
      return { resolved: false, reason: mismatch, cashfreeOrderId: null, cfPaymentId: null };
    }

    const verdict = verifyShopifyCashfreeIds(receipt, payment.amount.toString(), cashfreePayments, { environment: cashfreeEnvironment });
    if (!verdict.resolved) {
      await this.record(payment, { status: "FAILED", reason: verdict.reason });
      return verdict;
    }

    await this.runner.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(payment.orderId));
      const fresh = await tx.payment.findUniqueOrThrow({ where: { id: payment.id }, select: { metadata: true } });
      const meta = asRecord(fresh.metadata);
      const cf = asRecord(meta.cashfree);
      // Never overwrite references that were recorded meanwhile.
      if (cf.cashfreeOrderId && cf.cfPaymentId) return;
      const verifiedAt = (this.deps.now ?? (() => new Date()))().toISOString();
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          metadata: {
            ...meta,
            cashfree: { ...cf, cashfreeOrderId: verdict.cashfreeOrderId, cfPaymentId: verdict.cfPaymentId, idSource: "shopify-receipt-verified", idVerifiedAt: verifiedAt },
            cashfreeVerification: { status: "VERIFIED", checkedAt: verifiedAt },
          } as Prisma.InputJsonValue,
        },
      });
    });
    return verdict;
  }
}

export default CashfreeIdResolutionService;
