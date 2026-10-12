// What happens AFTER a Shopify order has been synced into the CRM, so that a prepaid Cashfree order can be refunded without any manual step:
//   1. Shopify's own refundable amount for the order is read (read-only) and stored on the order. It caps every refund the CRM will accept for the order
//      (refunds.balance.ts) - the CRM never allows more than Shopify says is available, and nothing about the figure is hard-coded.
//   2. the Cashfree payment is verified with the existing resolver (Shopify receipt cross-checked against Cashfree, environment-aware; refunds.resolve.ts). Only a
//      positively verified payment gets its Cashfree order id / payment id recorded; otherwise the reason is recorded and the payment stays not refundable.
// It runs strictly after the order's own transaction has committed and is best-effort: a failure here is logged by the caller and can never fail or undo the sync.
// It reads from Shopify and Cashfree and writes only to the CRM database. It never creates a refund and never calls a payment-changing API.
import { prisma } from "@/lib/prisma.js";
import { PaymentStatus } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { orderLockKey } from "../cashfree/cashfree.apply.js";
import { advisoryLock, asRecord, type TxRunner } from "../integrations/integrations.common.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { fromCents, toCents } from "../shopify/shopify.money.js";
import { cashfreeOrderIdOf, cashfreePaymentIdOf, isCashfreePayment } from "./refunds.eligibility.js";
import CashfreeIdResolutionService, { ShopifyReceiptReader, type ResolveDeps, type ResolveResult } from "./refunds.resolve.js";

export interface ShopifyRefundable {
  amount: string;
  currency: string;
}

const REFUNDABLE_QUERY = `query($id: ID!) { order(id: $id) { suggestedRefund(suggestFullRefund: false, refundShipping: true) { maximumRefundableSet { shopMoney { amount currencyCode } } } } }`;

/**
 * The most Shopify says can still be refunded on the order right now (its suggested-refund maximum, which already accounts for everything Shopify has refunded),
 * or null when Shopify does not say. Read-only (a query, not a mutation).
 */
export async function fetchShopifyRefundable(client: Pick<ShopifyClient, "query">, orderGid: string): Promise<ShopifyRefundable | null> {
  const data = await client.query<{ order?: { suggestedRefund?: { maximumRefundableSet?: { shopMoney?: { amount?: string; currencyCode?: string } } | null } | null } | null }>(REFUNDABLE_QUERY, { id: orderGid });
  const money = data.order?.suggestedRefund?.maximumRefundableSet?.shopMoney;
  if (!money?.amount || !money.currencyCode) return null;
  const cents = toCents(money.amount);
  return Number.isInteger(cents) && cents >= 0 ? { amount: fromCents(cents), currency: money.currencyCode } : null;
}

export interface AutoVerifyDeps {
  /** Shopify's currently refundable amount for an order (by GID). */
  refundable: (orderGid: string) => Promise<ShopifyRefundable | null>;
  resolver: Pick<CashfreeIdResolutionService, "resolveAutomatically">;
  now?: () => Date;
}

export interface AutoVerifyReport {
  /** Prepaid Shopify Cashfree payments looked at. */
  candidates: number;
  /** Shopify's refundable amount was read and stored. */
  refundableStored: boolean;
  verified: string[];
  failed: { paymentId: string; reason: string | null }[];
}

export class ShopifyCashfreeAutoVerifier {
  constructor(
    private readonly runner: TxRunner,
    private readonly deps: AutoVerifyDeps,
  ) {}

  async afterOrderSync(orderId: string): Promise<AutoVerifyReport> {
    const report: AutoVerifyReport = { candidates: 0, refundableStored: false, verified: [], failed: [] };
    const order = await this.runner.$transaction((tx) =>
      tx.order.findUnique({
        where: { id: orderId },
        select: { id: true, externalSource: true, externalId: true, payments: { where: { externalSource: "SHOPIFY" }, select: { id: true, status: true, method: true, provider: true, externalSource: true, metadata: true, providerPaymentId: true } } },
      }),
    );
    if (!order || order.externalSource !== "SHOPIFY" || !order.externalId) return report;

    // Only a successfully paid Cashfree payment is of interest: COD, other gateways, unpaid and failed payments are left exactly as they are.
    const candidates = order.payments.filter((p) => isCashfreePayment(p) && (p.status === PaymentStatus.SUCCESS || p.status === PaymentStatus.PARTIALLY_REFUNDED));
    report.candidates = candidates.length;
    if (candidates.length === 0) return report;

    // 1. Shopify's refundable amount. If Shopify cannot be read now, a previously stored figure stays (it is re-read before any refund is sent).
    try {
      const refundable = await this.deps.refundable(`gid://shopify/Order/${order.externalId}`);
      if (refundable) {
        await this.storeRefundable(order.id, refundable);
        report.refundableStored = true;
      }
    } catch {
      // not fatal: see above
    }

    // 2. Cashfree verification, for the payments that do not have verified references yet.
    for (const payment of candidates) {
      if (cashfreeOrderIdOf(payment) && cashfreePaymentIdOf(payment)) continue;
      const result: ResolveResult = await this.deps.resolver.resolveAutomatically(order.id, payment.id);
      if (result.resolved) report.verified.push(payment.id);
      else report.failed.push({ paymentId: payment.id, reason: result.reason });
    }
    return report;
  }

  /**
   * Re-reads Shopify's refundable amount for ONE Shopify order and stores it - the part of the post-sync step that needs no Cashfree. Used by the retry on an order
   * that is already in the CRM (there is no sync button on a CRM order). Returns whether a figure was stored.
   */
  async refreshRefundable(orderId: string): Promise<boolean> {
    const order = await this.runner.$transaction((tx) => tx.order.findUnique({ where: { id: orderId }, select: { externalSource: true, externalId: true } }));
    if (!order || order.externalSource !== "SHOPIFY" || !order.externalId) return false;
    const refundable = await this.deps.refundable(`gid://shopify/Order/${order.externalId}`);
    if (!refundable) return false;
    await this.storeRefundable(orderId, refundable);
    return true;
  }

  private async storeRefundable(orderId: string, refundable: ShopifyRefundable): Promise<void> {
    const fetchedAt = (this.deps.now ?? (() => new Date()))().toISOString();
    await this.runner.$transaction(async (tx) => {
      await advisoryLock(tx, orderLockKey(orderId));
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { metadata: true } });
      await tx.order.update({ where: { id: orderId }, data: { metadata: { ...asRecord(fresh.metadata), shopifyRefundable: { amount: refundable.amount, currency: refundable.currency, fetchedAt } } as Prisma.InputJsonValue } });
    });
  }
}

/** Refreshes Shopify's refundable amount on one CRM order (best effort for the caller: it throws if Shopify can not be read). */
export async function refreshShopifyRefundable(orderId: string, deps: { client?: Pick<ShopifyClient, "query">; runner?: TxRunner } = {}): Promise<boolean> {
  const runner = deps.runner ?? prisma;
  const client = deps.client ?? new ShopifyClient(loadShopifyConfig());
  const verifier = new ShopifyCashfreeAutoVerifier(runner, { refundable: (gid) => fetchShopifyRefundable(client, gid), resolver: new CashfreeIdResolutionService(runner) });
  return verifier.refreshRefundable(orderId);
}

/** The post-sync step for the Shopify sync pipeline (SyncDeps.afterCommit), bound to one Shopify client. */
export function createCashfreeAutoVerifyHook(client: Pick<ShopifyClient, "query">, runner: TxRunner = prisma, resolveDeps: Omit<ResolveDeps, "shopify"> = {}): (result: { orderId: string | null }) => Promise<void> {
  const verifier = new ShopifyCashfreeAutoVerifier(runner, {
    refundable: (gid) => fetchShopifyRefundable(client, gid),
    resolver: new CashfreeIdResolutionService(runner, { ...resolveDeps, shopify: () => new ShopifyReceiptReader(client) }),
  });
  return async (result) => {
    if (result.orderId) await verifier.afterOrderSync(result.orderId);
  };
}
