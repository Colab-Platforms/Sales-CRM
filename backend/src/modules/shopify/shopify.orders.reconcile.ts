import { ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { fromCents, toCents } from "./shopify.money.js";
import { toShopifyOrderGid } from "./shopify.orders.write.js";

// Representing a Prepaid Upgrade on the EXISTING Shopify order, without a false financial record.
//
//   original COD order  699  (Shopify: PENDING, outstanding 699)
//   prepaid discount    100  (what the CRM granted for paying online)
//   actually collected  599  (Cashfree)
//
// Shopify's orderMarkAsPaid clears the whole outstanding balance, so on the ORIGINAL order it would record 699 as received.
// orderCreateManualPayment can take an explicit partial `amount`, but Shopify only allows that field for Plus stores, and a
// partial payment would still leave the order "partially paid" with 100 outstanding. The supported way to make the order's own
// financial total 599 is a legitimate ORDER EDIT: the 100 becomes a line-item discount (Shopify keeps the order's edit history,
// number and id; it shows the original total, the adjustment and the new total). With the order total at 599, a manual payment
// WITHOUT an amount records exactly the outstanding 599 - labelled with the real gateway - and the order reads Paid with a net
// of 599. Nothing here creates a second order, cancels/recreates, or invents a transaction for 699.
//
// Safety: the order's state is re-read from Shopify before every step, so a retry resumes where it stopped and can never
// double-apply the discount or double-record the payment; the edit is checked BEFORE it is committed (staged total must be
// exactly the prepaid amount) and the payment is only recorded when the outstanding amount is exactly the prepaid amount.
// Needs the `write_orders` and `write_order_edits` scopes (order editing is a separate Shopify scope).

export class ShopifyReconcileError extends Error {
  constructor(message: string, readonly step: string, readonly raw?: unknown) {
    super(message);
    this.name = "ShopifyReconcileError";
  }
}

interface Money { shopMoney: { amount: string } }
interface OrderState {
  order: { id: string; displayFinancialStatus: string | null; cancelledAt: string | null; currentTotalPriceSet: Money; totalOutstandingSet: Money; totalReceivedSet: Money | null } | null;
}

const STATE_QUERY = `
  query crmPrepaidUpgradeOrderState($id: ID!) {
    order(id: $id) {
      id
      displayFinancialStatus
      cancelledAt
      currentTotalPriceSet { shopMoney { amount } }
      totalOutstandingSet { shopMoney { amount } }
      totalReceivedSet { shopMoney { amount } }
    }
  }
`;
const EDIT_BEGIN = `
  mutation crmPrepaidUpgradeEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder { id lineItems(first: 100) { nodes { id quantity originalUnitPriceSet { shopMoney { amount } } } } }
      userErrors { field message }
    }
  }
`;
const EDIT_DISCOUNT = `
  mutation crmPrepaidUpgradeEditDiscount($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) {
    orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
      calculatedOrder { id totalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } } }
      userErrors { field message }
    }
  }
`;
const EDIT_COMMIT = `
  mutation crmPrepaidUpgradeEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order { id }
      userErrors { field message }
    }
  }
`;
const MANUAL_PAYMENT = `
  mutation crmPrepaidUpgradeManualPayment($id: ID!, $paymentMethodName: String) {
    orderCreateManualPayment(id: $id, paymentMethodName: $paymentMethodName) {
      order { id displayFinancialStatus }
      userErrors { field message }
    }
  }
`;

type UserErrors = { field: string[] | null; message: string }[];

async function run<T>(client: ShopifyClient, step: string, query: string, variables: Record<string, unknown>): Promise<T> {
  try {
    return await client.query<T>(query, variables);
  } catch (error) {
    if (error instanceof ShopifyGraphQLError) throw new ShopifyReconcileError(error.message, step, error);
    throw error;
  }
}
const failIfErrors = (step: string, errors: UserErrors | undefined | null) => {
  if (errors && errors.length > 0) throw new ShopifyReconcileError(errors.map((e) => e.message).join("; "), step, errors);
};

export interface PrepaidUpgradeReconcileInput {
  /** What the order was before the offer (Shopify total), and what the customer was asked to pay - both as decimal strings. */
  originalAmount: string;
  discountAmount: string;
  prepaidAmount: string;
  currency: string;
  /** Free text recorded on the order edit and as the payment method name (customer-safe, no ids/secrets). */
  upgradeReference: string;
  /** Wording for the order edit and the payment. Defaults describe a Prepaid Upgrade; a CRM order discount (WhatsApp Inbox) passes its own. */
  labels?: { discount: string; payment: string; note: string };
}

export interface PrepaidUpgradeReconcileResult {
  shopifyOrderId: string;
  financialStatus: string | null;
  /** What this call actually did: nothing (already reconciled), only the payment, or the edit then the payment. */
  performed: "already_reconciled" | "payment_only" | "edit_and_payment";
  /** Net amount Shopify now shows as received on the order. */
  received: string | null;
}

async function readState(client: ShopifyClient, gid: string) {
  const data = await run<OrderState>(client, "read_order", STATE_QUERY, { id: gid });
  if (!data.order) throw new ShopifyReconcileError("Shopify no longer has this order.", "read_order");
  const o = data.order;
  return { status: o.displayFinancialStatus, cancelled: Boolean(o.cancelledAt), total: toCents(o.currentTotalPriceSet.shopMoney.amount), outstanding: toCents(o.totalOutstandingSet.shopMoney.amount), received: o.totalReceivedSet ? toCents(o.totalReceivedSet.shopMoney.amount) : 0 };
}

export async function reconcilePrepaidUpgrade(client: ShopifyClient, shopifyOrderId: string, input: PrepaidUpgradeReconcileInput): Promise<PrepaidUpgradeReconcileResult> {
  const gid = toShopifyOrderGid(shopifyOrderId);
  const original = toCents(input.originalAmount);
  const discount = toCents(input.discountAmount);
  const prepaid = toCents(input.prepaidAmount);
  if (!(prepaid > 0) || discount <= 0 || original - discount !== prepaid) throw new ShopifyReconcileError("The prepaid upgrade amounts are inconsistent; nothing was sent to Shopify.", "validate");

  let state = await readState(client, gid);
  if (state.cancelled) throw new ShopifyReconcileError("The Shopify order is cancelled; it was not changed.", "read_order");

  // Already reconciled (a retry, or a duplicate trigger): net 599 received and nothing outstanding -> nothing to do.
  if (state.total === prepaid && state.outstanding === 0 && state.received === prepaid) {
    return { shopifyOrderId: gid, financialStatus: state.status, performed: "already_reconciled", received: fromCents(state.received) };
  }
  // Anything else that is not exactly one of the two expected starting points is refused rather than forced.
  const needsEdit = state.total === original;
  if (!needsEdit && state.total !== prepaid) throw new ShopifyReconcileError(`Shopify's order total (${fromCents(state.total)}) is neither the original (${fromCents(original)}) nor the prepaid amount (${fromCents(prepaid)}); it was not changed.`, "read_order");
  if (needsEdit && state.outstanding !== original) throw new ShopifyReconcileError("The Shopify order already has a payment recorded, so the discount can not be applied cleanly; it was not changed.", "read_order");

  if (needsEdit) {
    const begin = await run<{ orderEditBegin: { calculatedOrder: { id: string; lineItems: { nodes: { id: string; quantity: number; originalUnitPriceSet: Money }[] } } | null; userErrors: UserErrors } }>(client, "edit_begin", EDIT_BEGIN, { id: gid });
    failIfErrors("edit_begin", begin.orderEditBegin.userErrors);
    const calc = begin.orderEditBegin.calculatedOrder;
    if (!calc) throw new ShopifyReconcileError("Shopify did not open an order edit.", "edit_begin");
    // The discount goes on ONE line that is worth at least the whole discount (largest first), so it is a plain fixed amount off that line.
    const line = [...calc.lineItems.nodes].map((l) => ({ id: l.id, worth: toCents(l.originalUnitPriceSet.shopMoney.amount) * l.quantity })).filter((l) => l.worth >= discount).sort((a, b) => b.worth - a.worth)[0];
    if (!line) throw new ShopifyReconcileError("No single line item on the Shopify order is large enough to carry the discount; it was not changed.", "edit_begin");
    const staged = await run<{ orderEditAddLineItemDiscount: { calculatedOrder: { totalPriceSet: Money; totalOutstandingSet: Money } | null; userErrors: UserErrors } }>(client, "edit_discount", EDIT_DISCOUNT, {
      id: calc.id,
      lineItemId: line.id,
      discount: { description: (input.labels?.discount ?? `Prepaid upgrade discount (${input.upgradeReference})`).slice(0, 100), fixedValue: { amount: fromCents(discount), currencyCode: input.currency } },
    });
    failIfErrors("edit_discount", staged.orderEditAddLineItemDiscount.userErrors);
    const stagedTotal = staged.orderEditAddLineItemDiscount.calculatedOrder ? toCents(staged.orderEditAddLineItemDiscount.calculatedOrder.totalPriceSet.shopMoney.amount) : null;
    // Check BEFORE committing: an edit session that is never committed is simply discarded by Shopify.
    if (stagedTotal !== prepaid) throw new ShopifyReconcileError(`The edited Shopify order would total ${stagedTotal === null ? "an unknown amount" : fromCents(stagedTotal)}, not ${fromCents(prepaid)}; the edit was not committed.`, "edit_discount");
    const commit = await run<{ orderEditCommit: { order: { id: string } | null; userErrors: UserErrors } }>(client, "edit_commit", EDIT_COMMIT, { id: calc.id, staffNote: `${input.labels?.note ?? `Prepaid upgrade ${input.upgradeReference}`}: original ${fromCents(original)}, discount ${fromCents(discount)}, pay ${fromCents(prepaid)}` });
    failIfErrors("edit_commit", commit.orderEditCommit.userErrors);
    state = await readState(client, gid);
    if (state.total !== prepaid) throw new ShopifyReconcileError(`After the edit Shopify's order total is ${fromCents(state.total)}, expected ${fromCents(prepaid)}; no payment was recorded.`, "edit_commit");
  }

  // The payment: no explicit amount, so Shopify records exactly the outstanding balance - which must be the prepaid amount.
  if (state.outstanding !== prepaid) throw new ShopifyReconcileError(`Shopify shows ${fromCents(state.outstanding)} outstanding, expected ${fromCents(prepaid)}; no payment was recorded.`, "payment");
  const paid = await run<{ orderCreateManualPayment: { order: { id: string; displayFinancialStatus: string | null } | null; userErrors: UserErrors } }>(client, "payment", MANUAL_PAYMENT, { id: gid, paymentMethodName: (input.labels?.payment ?? `Cashfree (prepaid upgrade ${input.upgradeReference})`).slice(0, 100) });
  failIfErrors("payment", paid.orderCreateManualPayment.userErrors);

  const final = await readState(client, gid);
  if (final.outstanding !== 0 || final.received !== prepaid) throw new ShopifyReconcileError(`After recording the payment Shopify shows ${fromCents(final.received)} received and ${fromCents(final.outstanding)} outstanding.`, "payment");
  return { shopifyOrderId: gid, financialStatus: paid.orderCreateManualPayment.order?.displayFinancialStatus ?? final.status, performed: needsEdit ? "edit_and_payment" : "payment_only", received: fromCents(final.received) };
}
