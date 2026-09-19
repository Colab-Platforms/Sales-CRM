import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus, ProductStatus } from "../../../generated/prisma/enums.js";
import { codOrderNode, normalized, orderNode, rawFulfillment, rawLineItem, rawTransaction, money } from "./shopify.fixtures.js";
import { isCodOrder, mapCustomer, mapOrder, mapOrderStatus, mapPayments, mapProduct, type StatusInput } from "./shopify.mapper.js";
import { fromCents, gidToId, sumCents, toCents, toGid } from "./shopify.money.js";
import { derivePaymentMode } from "../orders/orders.filters.js";

const status = (overrides: Partial<StatusInput> = {}) =>
  mapOrderStatus({
    cancelledAt: null, financialStatus: "PAID", fulfillmentStatus: "UNFULFILLED", returnStatus: "NO_RETURN",
    fulfillments: [], tags: [], isCod: false, ...overrides,
  }).status;

const payments = (node: Record<string, unknown>) => mapPayments(normalized(node));

describe("Shopify ids", () => {
  it("turns a GraphQL id into the numeric id used as the external id", () => {
    assert.equal(gidToId("gid://shopify/Order/1000000000001"), "1000000000001");
    assert.equal(gidToId(1000000000001), "1000000000001");
    assert.equal(gidToId("123"), "123");
  });

  it("builds a GraphQL id from a webhook's numeric id, leaving real ones alone", () => {
    assert.equal(toGid("Order", 55), "gid://shopify/Order/55");
    assert.equal(toGid("Product", "gid://shopify/Product/9"), "gid://shopify/Product/9");
  });

  it("does money maths in cents", () => {
    assert.equal(toCents("649.0"), 64900);
    assert.equal(toCents("0.1") + toCents("0.2"), 30);
    assert.equal(fromCents(sumCents(["100.10", "200.20"])), "300.30");
    assert.equal(toCents(null), 0);
  });
});

describe("order status mapping", () => {
  it("confirms a paid order that has not shipped", () => assert.equal(status(), OrderStatus.CONFIRMED));

  it("confirms a cash-on-delivery order even though nothing is paid yet", () => {
    assert.equal(status({ financialStatus: "PENDING", isCod: true }), OrderStatus.CONFIRMED);
  });

  it("keeps a prepaid order awaiting payment until it is paid", () => {
    assert.equal(status({ financialStatus: "PENDING" }), OrderStatus.PENDING_PAYMENT);
    assert.equal(status({ financialStatus: "AUTHORIZED" }), OrderStatus.PENDING_PAYMENT);
  });

  it("maps partial and in-progress fulfilment to processing", () => {
    for (const fulfillmentStatus of ["PARTIALLY_FULFILLED", "IN_PROGRESS", "PENDING_FULFILLMENT", "ON_HOLD"]) {
      assert.equal(status({ fulfillmentStatus }), OrderStatus.PROCESSING, fulfillmentStatus);
    }
  });

  it("maps a fulfilled order by how far its shipment has got", () => {
    const fulfilled = (displayStatus: string) => status({ fulfillmentStatus: "FULFILLED", fulfillments: [{ status: "SUCCESS", displayStatus }] });
    assert.equal(fulfilled("IN_TRANSIT"), OrderStatus.SHIPPED);
    assert.equal(fulfilled("LABEL_PRINTED"), OrderStatus.SHIPPED);
    assert.equal(fulfilled("OUT_FOR_DELIVERY"), OrderStatus.OUT_FOR_DELIVERY);
    assert.equal(fulfilled("ATTEMPTED_DELIVERY"), OrderStatus.OUT_FOR_DELIVERY);
    assert.equal(fulfilled("DELIVERED"), OrderStatus.DELIVERED);
  });

  it("treats a fulfilled order with no shipment details as shipped", () => {
    assert.equal(status({ fulfillmentStatus: "FULFILLED", fulfillments: [] }), OrderStatus.SHIPPED);
  });

  it("is only delivered when every shipment is delivered", () => {
    const shipments = [{ status: "SUCCESS", displayStatus: "DELIVERED" }, { status: "SUCCESS", displayStatus: "IN_TRANSIT" }];
    assert.equal(status({ fulfillmentStatus: "FULFILLED", fulfillments: shipments }), OrderStatus.SHIPPED);
  });

  it("ignores cancelled shipments", () => {
    const shipments = [{ status: "CANCELLED", displayStatus: "CANCELED" }, { status: "SUCCESS", displayStatus: "DELIVERED" }];
    assert.equal(status({ fulfillmentStatus: "FULFILLED", fulfillments: shipments }), OrderStatus.DELIVERED);
  });

  it("maps a parcel returned to origin (Shiprocket tag) to returned", () => {
    const shipments = [{ status: "SUCCESS", displayStatus: "NOT_DELIVERED" }];
    assert.equal(status({ fulfillmentStatus: "FULFILLED", fulfillments: shipments, tags: ["RTO Initiated via Shiprocket", "RTO Delivered via Shiprocket"] }), OrderStatus.RETURNED);
    // Only "initiated" is not yet returned.
    assert.equal(status({ fulfillmentStatus: "FULFILLED", fulfillments: shipments, tags: ["RTO Initiated via Shiprocket"] }), OrderStatus.SHIPPED);
  });

  it("does not treat an RTO tag on an unfulfilled order as returned", () => {
    assert.equal(status({ fulfillmentStatus: "UNFULFILLED", tags: ["RTO Delivered via Shiprocket"] }), OrderStatus.CONFIRMED);
  });

  it("maps Shopify's own return statuses and restocked orders to returned", () => {
    assert.equal(status({ returnStatus: "RETURNED" }), OrderStatus.RETURNED);
    assert.equal(status({ returnStatus: "INSPECTION_COMPLETE" }), OrderStatus.RETURNED);
    assert.equal(status({ fulfillmentStatus: "RESTOCKED" }), OrderStatus.RETURNED);
    assert.equal(status({ returnStatus: "RETURN_REQUESTED", fulfillmentStatus: "FULFILLED" }), OrderStatus.SHIPPED);
  });

  it("cancelled wins over everything", () => {
    assert.equal(status({ cancelledAt: "2026-09-20T00:00:00Z", fulfillmentStatus: "FULFILLED", financialStatus: "REFUNDED" }), OrderStatus.CANCELLED);
    assert.equal(status({ financialStatus: "VOIDED" }), OrderStatus.CANCELLED);
    assert.equal(status({ financialStatus: "EXPIRED" }), OrderStatus.CANCELLED);
  });

  it("maps a fully refunded, not cancelled, order to refunded", () => {
    assert.equal(status({ financialStatus: "REFUNDED" }), OrderStatus.REFUNDED);
  });

  it("reports, rather than silently drops, a status it does not recognise", () => {
    const result = mapOrderStatus({
      cancelledAt: null, financialStatus: "SOMETHING_NEW", fulfillmentStatus: "BRAND_NEW", returnStatus: null, fulfillments: [], tags: [], isCod: false,
    });
    assert.deepEqual(result.unmapped, ["financialStatus:SOMETHING_NEW", "fulfillmentStatus:BRAND_NEW"]);
    assert.equal(result.status, OrderStatus.PENDING_PAYMENT);
  });
});

describe("cash on delivery detection", () => {
  it("recognises the gateway name, the transaction gateway, or a tag", () => {
    assert.equal(isCodOrder(normalized(codOrderNode())), true);
    assert.equal(isCodOrder(normalized(orderNode({ paymentGatewayNames: [], tags: ["cash on delivery"], transactions: [] }))), true);
    assert.equal(isCodOrder(normalized(orderNode({ paymentGatewayNames: [], tags: [], transactions: [rawTransaction({ gateway: "Cash on Delivery (COD)" })] }))), true);
  });

  it("does not mistake a prepaid order for COD", () => {
    assert.equal(isCodOrder(normalized(orderNode())), false);
    assert.equal(isCodOrder(normalized(orderNode({ paymentGatewayNames: ["Snapmint"], tags: ["prepaid"] }))), false);
  });
});

describe("payment mapping", () => {
  it("maps a successful prepaid sale to SUCCESS with the gateway reference", () => {
    const [p] = payments(orderNode());
    assert.equal(p.status, PaymentStatus.SUCCESS);
    assert.equal(p.method, PaymentMethod.OTHER);
    assert.equal(p.provider, "Cashfree");
    assert.equal(p.amount, "649.0");
    assert.equal(p.transactionReference, "cf_pay_123");
    assert.equal(p.externalId, "8800001");
    assert.ok(p.paidAt);
  });

  it("maps a pending COD transaction to COD + PENDING", () => {
    const [p] = payments(codOrderNode());
    assert.equal(p.status, PaymentStatus.PENDING);
    assert.equal(p.method, PaymentMethod.COD);
    assert.equal(p.amount, "699.0");
    assert.equal(p.paidAt, null);
  });

  it("maps a collected COD payment to COD + SUCCESS", () => {
    const [p] = payments(codOrderNode({
      displayFinancialStatus: "PAID",
      transactions: [rawTransaction({ id: "gid://shopify/OrderTransaction/1", gateway: "Cash on Delivery (COD)", status: "SUCCESS", amountSet: money("699.0") })],
    }));
    assert.equal(p.status, PaymentStatus.SUCCESS);
    assert.equal(p.method, PaymentMethod.COD);
  });

  it("gives a COD order with no transaction a placeholder pending COD payment", () => {
    const [p] = payments(orderNode({ displayFinancialStatus: "PENDING", paymentGatewayNames: [], tags: ["cash on delivery"], transactions: [], totalPriceSet: money("699.0") }));
    assert.equal(p.status, PaymentStatus.PENDING);
    assert.equal(p.method, PaymentMethod.COD);
    assert.equal(p.amount, "699.0");
    assert.match(p.externalId, /^synthetic-/);
  });

  it("keeps the payment method unknown when nothing says how the order is paid", () => {
    const [p] = payments(orderNode({ displayFinancialStatus: "PENDING", paymentGatewayNames: [], tags: [], transactions: [] }));
    assert.equal(p.method, null);
    assert.equal(p.status, PaymentStatus.PENDING);
  });

  it("treats a prepaid-tagged order with no transaction as prepaid and pending", () => {
    const [p] = payments(orderNode({ displayFinancialStatus: "PENDING", paymentGatewayNames: [], tags: ["prepaid"], transactions: [] }));
    assert.equal(p.method, PaymentMethod.OTHER);
    assert.equal(p.status, PaymentStatus.PENDING);
  });

  it("maps failed and errored sales to FAILED with the reason", () => {
    for (const status of ["FAILURE", "ERROR"]) {
      const [p] = payments(orderNode({ transactions: [rawTransaction({ status, errorCode: "CARD_DECLINED" })] }));
      assert.equal(p.status, PaymentStatus.FAILED, status);
      assert.equal(p.failureReason, "CARD_DECLINED");
      assert.ok(p.failedAt);
    }
  });

  it("keeps a failed attempt and its successful retry as two payments", () => {
    const result = payments(orderNode({
      transactions: [
        rawTransaction({ id: "gid://shopify/OrderTransaction/1", status: "FAILURE", processedAt: "2026-09-19T10:00:00Z" }),
        rawTransaction({ id: "gid://shopify/OrderTransaction/2", status: "SUCCESS", processedAt: "2026-09-19T10:02:00Z" }),
      ],
    }));
    assert.deepEqual(result.map((p) => p.status), [PaymentStatus.FAILED, PaymentStatus.SUCCESS]);
  });

  it("holds an authorization as PROCESSING until captured, then SUCCESS", () => {
    const authorization = rawTransaction({ id: "gid://shopify/OrderTransaction/10", kind: "AUTHORIZATION", status: "SUCCESS" });
    assert.equal(payments(orderNode({ transactions: [authorization] }))[0].status, PaymentStatus.PROCESSING);

    const capture = rawTransaction({ id: "gid://shopify/OrderTransaction/11", kind: "CAPTURE", status: "SUCCESS", parentTransaction: { id: "gid://shopify/OrderTransaction/10" }, amountSet: money("640.0") });
    const captured = payments(orderNode({ transactions: [authorization, capture] }));
    assert.equal(captured.length, 1);
    assert.equal(captured[0].status, PaymentStatus.SUCCESS);
    assert.equal(captured[0].amount, "640.0");
  });

  it("marks a delivered cash-on-delivery order paid: a PENDING sale plus a successful capture is SUCCESS, not PENDING", () => {
    const sale = rawTransaction({ id: "gid://shopify/OrderTransaction/20", kind: "SALE", status: "PENDING", gateway: "Cash on Delivery (COD)", amountSet: money("698.0"), processedAt: "2026-01-01T02:00:00Z" });
    const capture = rawTransaction({
      id: "gid://shopify/OrderTransaction/21", kind: "CAPTURE", status: "SUCCESS", gateway: "Cash on Delivery (COD)", amountSet: money("698.0"),
      parentTransaction: { id: "gid://shopify/OrderTransaction/20" }, processedAt: "2026-01-06T09:30:00Z",
    });
    const paid = payments(codOrderNode({ displayFinancialStatus: "PAID", transactions: [sale, capture] }));
    assert.equal(paid.length, 1, "the capture is part of the sale, not a second payment");
    assert.equal(paid[0].status, PaymentStatus.SUCCESS);
    assert.equal(paid[0].method, PaymentMethod.COD);
    assert.equal(paid[0].amount, "698.0");
    assert.equal(paid[0].paidAt?.toISOString(), "2026-01-06T09:30:00.000Z", "paid when the cash was collected");

    // Until the capture exists it is still pending.
    assert.equal(payments(codOrderNode({ transactions: [sale] }))[0].status, PaymentStatus.PENDING);

    // A refund of a collected COD payment is attributed to it.
    const refund = rawTransaction({ id: "gid://shopify/OrderTransaction/22", kind: "REFUND", status: "SUCCESS", gateway: "Cash on Delivery (COD)", amountSet: money("698.0"), parentTransaction: { id: "gid://shopify/OrderTransaction/21" }, processedAt: "2026-01-10T00:00:00Z" });
    const refunded = payments(codOrderNode({ displayFinancialStatus: "REFUNDED", transactions: [sale, capture, refund] }));
    assert.equal(refunded[0].status, PaymentStatus.REFUNDED);
    assert.equal(refunded[0].refundedAmount, "698.00");
  });

  it("treats a follow-up SALE that names the pending COD sale as its parent as that sale being marked paid, not a second payment", () => {
    // The most common real shape: about a quarter of this store's orders are COD orders the courier marked as paid.
    const pending = rawTransaction({ id: "gid://shopify/OrderTransaction/30", kind: "SALE", status: "PENDING", gateway: "Cash on Delivery (COD)", amountSet: money("698.0") });
    const settled = rawTransaction({
      id: "gid://shopify/OrderTransaction/31", kind: "SALE", status: "SUCCESS", gateway: "Cash on Delivery (COD)", amountSet: money("698.0"),
      parentTransaction: { id: "gid://shopify/OrderTransaction/30" }, processedAt: "2026-04-20T08:00:00Z",
    });
    const result = payments(codOrderNode({ displayFinancialStatus: "PAID", transactions: [pending, settled] }));
    assert.equal(result.length, 1);
    assert.equal(result[0].status, PaymentStatus.SUCCESS);
    assert.equal(result[0].externalId, "30", "still identified by the original sale, so re-syncing updates it in place");
    assert.equal(result[0].method, PaymentMethod.COD);
    assert.equal(result[0].paidAt?.toISOString(), "2026-04-20T08:00:00.000Z");
  });

  it("keeps a genuine split (an online payment plus a settled COD balance) as two payments", () => {
    const cod = rawTransaction({ id: "gid://shopify/OrderTransaction/40", kind: "SALE", status: "PENDING", gateway: "Cash on Delivery (COD)", amountSet: money("500.0") });
    const codPaid = rawTransaction({ id: "gid://shopify/OrderTransaction/41", kind: "SALE", status: "SUCCESS", gateway: "Cash on Delivery (COD)", amountSet: money("500.0"), parentTransaction: { id: "gid://shopify/OrderTransaction/40" } });
    const online = rawTransaction({ id: "gid://shopify/OrderTransaction/42", kind: "SALE", status: "SUCCESS", gateway: "Cashfree", amountSet: money("199.0") });
    const result = payments(codOrderNode({ displayFinancialStatus: "PAID", transactions: [cod, online, codPaid] }));
    assert.deepEqual(result.map((p) => [p.externalId, p.status, p.amount]), [["40", PaymentStatus.SUCCESS, "500.0"], ["42", PaymentStatus.SUCCESS, "199.0"]]);
  });

  it("keeps an unpaid COD balance pending next to a part payment", () => {
    const online = rawTransaction({ id: "gid://shopify/OrderTransaction/50", kind: "SALE", status: "SUCCESS", gateway: "shopflo", amountSet: money("100.0") });
    const cod = rawTransaction({ id: "gid://shopify/OrderTransaction/51", kind: "SALE", status: "PENDING", gateway: "Cash on Delivery (COD)", amountSet: money("598.0") });
    const result = payments(codOrderNode({ displayFinancialStatus: "PARTIALLY_PAID", transactions: [online, cod] }));
    assert.deepEqual(result.map((p) => p.status), [PaymentStatus.SUCCESS, PaymentStatus.PENDING]);
  });

  it("marks a voided authorization as failed", () => {
    const authorization = rawTransaction({ id: "gid://shopify/OrderTransaction/10", kind: "AUTHORIZATION", status: "SUCCESS" });
    const voided = rawTransaction({ id: "gid://shopify/OrderTransaction/12", kind: "VOID", status: "SUCCESS", parentTransaction: { id: "gid://shopify/OrderTransaction/10" } });
    const [p] = payments(orderNode({ transactions: [authorization, voided] }));
    assert.equal(p.status, PaymentStatus.FAILED);
    assert.equal(p.failureReason, "Authorization voided");
  });

  it("marks a fully refunded sale REFUNDED, with amount and date", () => {
    const refund = rawTransaction({ id: "gid://shopify/OrderTransaction/20", kind: "REFUND", status: "SUCCESS", processedAt: "2026-09-25T08:00:00Z", parentTransaction: { id: "gid://shopify/OrderTransaction/8800001" } });
    const [p] = payments(orderNode({ displayFinancialStatus: "REFUNDED", transactions: [rawTransaction({ id: "gid://shopify/OrderTransaction/8800001" }), refund] }));
    assert.equal(p.status, PaymentStatus.REFUNDED);
    assert.equal(p.refundedAmount, "649.00");
    assert.equal(p.refundedAt?.toISOString(), "2026-09-25T08:00:00.000Z");
  });

  it("marks a partly refunded sale PARTIALLY_REFUNDED", () => {
    const refund = rawTransaction({ id: "gid://shopify/OrderTransaction/21", kind: "REFUND", status: "SUCCESS", amountSet: money("200.0"), parentTransaction: { id: "gid://shopify/OrderTransaction/8800001" } });
    const [p] = payments(orderNode({ displayFinancialStatus: "PARTIALLY_REFUNDED", transactions: [rawTransaction({ id: "gid://shopify/OrderTransaction/8800001" }), refund] }));
    assert.equal(p.status, PaymentStatus.PARTIALLY_REFUNDED);
    assert.equal(p.refundedAmount, "200.00");
  });

  it("attaches a refund with no known parent to the paid payment, and ignores failed refunds", () => {
    const orphan = rawTransaction({ id: "gid://shopify/OrderTransaction/22", kind: "REFUND", status: "SUCCESS" });
    const failedRefund = rawTransaction({ id: "gid://shopify/OrderTransaction/23", kind: "REFUND", status: "FAILURE" });
    const [p] = payments(orderNode({ transactions: [rawTransaction({ id: "gid://shopify/OrderTransaction/8800001" }), orphan, failedRefund] }));
    assert.equal(p.status, PaymentStatus.REFUNDED);
    assert.equal(p.refundedAmount, "649.00");
  });

  it("derives the E6 payment mode (COD / prepaid / unknown) from the mapped payments", () => {
    assert.equal(derivePaymentMode(payments(codOrderNode())), "COD");
    assert.equal(derivePaymentMode(payments(orderNode())), "PREPAID");
    assert.equal(derivePaymentMode(payments(orderNode({ displayFinancialStatus: "PENDING", paymentGatewayNames: [], tags: [], transactions: [] }))), null);
  });
});

describe("order mapping", () => {
  it("maps a real-shaped prepaid order", () => {
    const o = mapOrder(normalized(orderNode()));
    assert.equal(o.externalId, "1000000000001");
    assert.equal(o.externalNumber, "#TST1001");
    assert.equal(o.orderNumber, "SHP-TST1001");
    assert.equal(o.source, OrderSource.SHOPIFY);
    assert.equal(o.status, OrderStatus.CONFIRMED);
    assert.equal(o.currency, "INR");
    assert.equal(o.totalAmount, "649.00");
    assert.equal(o.shippingPincode, "786125");
    assert.equal(o.shippingAddress?.city, "Tinsukia");
    assert.equal(o.createdAt.toISOString(), "2026-09-19T10:00:00.000Z");
    assert.equal(o.externalUpdatedAt.toISOString(), "2026-09-19T10:05:00.000Z");
    assert.deepEqual(o.warnings, []);
  });

  it("maps a COD order with shipping, and records COD in the metadata", () => {
    const o = mapOrder(normalized(codOrderNode()));
    assert.equal(o.orderNumber, "SHP-TST1002");
    assert.equal(o.subtotal, "649.00");
    assert.equal(o.shippingAmount, "50.00");
    assert.equal(o.totalAmount, "699.00");
    assert.equal(o.status, OrderStatus.CONFIRMED);
    assert.equal(o.metadata.paymentMode, "COD");
    assert.deepEqual(o.warnings, []);
  });

  it("rebuilds the pre-discount subtotal from line items (Shopify's subtotal is after discounts)", () => {
    const o = mapOrder(normalized(orderNode({
      subtotalPriceSet: money("100.0"), totalDiscountsSet: money("549.0"), totalPriceSet: money("100.0"),
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [rawLineItem({ discountAllocations: [{ allocatedAmountSet: money("549.0") }] })] },
    })));
    assert.equal(o.subtotal, "649.00");
    assert.equal(o.discountAmount, "549.00");
    assert.equal(o.totalAmount, "100.00");
    assert.equal(o.items[0].discountAmount, "549.00");
    assert.equal(o.items[0].totalPrice, "100.00");
    assert.deepEqual(o.warnings, []);
  });

  it("adds tax on top when prices do not include it", () => {
    const o = mapOrder(normalized(orderNode({
      taxesIncluded: false, totalTaxSet: money("116.82"), totalPriceSet: money("765.82"),
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [rawLineItem({ taxLines: [{ priceSet: money("116.82") }] })] },
    })));
    assert.equal(o.items[0].taxAmount, "116.82");
    assert.equal(o.items[0].totalPrice, "765.82");
    assert.deepEqual(o.warnings, []);
  });

  it("maps line items with product and variant references and drops the 'Default Title' variant", () => {
    const o = mapOrder(normalized(orderNode({
      lineItems: { pageInfo: { hasNextPage: false }, nodes: [rawLineItem({ variantTitle: "Default Title", quantity: 2, product: null, variant: null })] },
      subtotalPriceSet: money("1298.0"), totalPriceSet: money("1298.0"),
    })));
    assert.equal(o.items[0].variantName, null);
    assert.equal(o.items[0].productExternalId, null);
    assert.equal(o.items[0].quantity, 2);
    assert.equal(o.items[0].totalPrice, "1298.00");

    const linked = mapOrder(normalized(orderNode()));
    assert.equal(linked.items[0].productExternalId, "5001");
    assert.equal(linked.items[0].variantExternalId, "6001");
    assert.equal(linked.items[0].variantName, "Paan Masala Flavour / 60 - Pouches");
    assert.equal(linked.items[0].sku, "AW-HM-PN-60");
  });

  it("flags totals that do not reconcile instead of hiding them", () => {
    const o = mapOrder(normalized(orderNode({ totalPriceSet: money("700.0") })));
    assert.equal(o.warnings.length, 1);
    assert.match(o.warnings[0], /do not reconcile/);
    assert.deepEqual(o.metadata.reconciliation, { expected: "649.00", actual: "700.00", difference: "51.00" });
  });

  it("keeps unrecognised Shopify statuses in the metadata and warns", () => {
    const o = mapOrder(normalized(orderNode({ displayFinancialStatus: "MYSTERY" })));
    assert.deepEqual(o.metadata.unmappedStatuses, ["financialStatus:MYSTERY"]);
    assert.match(o.warnings.join(" "), /Unrecognised Shopify status/);
  });

  it("maps a cancelled order with its reason and time", () => {
    const o = mapOrder(normalized(orderNode({ cancelledAt: "2026-09-19T11:00:00Z", cancelReason: "CUSTOMER" })));
    assert.equal(o.status, OrderStatus.CANCELLED);
    assert.equal(o.cancelReason, "CUSTOMER");
    assert.equal(o.cancelledAt?.toISOString(), "2026-09-19T11:00:00.000Z");
    assert.equal(o.confirmedAt, null);
  });

  it("maps a delivered order and keeps tracking details in the metadata", () => {
    const o = mapOrder(normalized(orderNode({ displayFulfillmentStatus: "FULFILLED", fulfillments: [rawFulfillment("DELIVERED")] })));
    assert.equal(o.status, OrderStatus.DELIVERED);
    assert.equal((o.metadata.shopify as { fulfillments: { trackingNumber: string }[] }).fulfillments[0].trackingNumber, "SR12345");
    assert.ok(o.confirmedAt);
  });

  it("maps a fully refunded order", () => {
    const refund = rawTransaction({ id: "gid://shopify/OrderTransaction/30", kind: "REFUND", parentTransaction: { id: "gid://shopify/OrderTransaction/8800001" } });
    const o = mapOrder(normalized(orderNode({
      displayFinancialStatus: "REFUNDED", totalRefundedSet: money("649.0"),
      transactions: [rawTransaction({ id: "gid://shopify/OrderTransaction/8800001" }), refund],
    })));
    assert.equal(o.status, OrderStatus.REFUNDED);
    assert.equal(o.payments[0].status, PaymentStatus.REFUNDED);
  });

  it("takes contact details from the customer, then the order, then the shipping address", () => {
    const guest = mapOrder(normalized(orderNode({ customer: null, email: null, phone: null })));
    assert.equal(guest.identity.externalId, null);
    assert.equal(guest.identity.phone, "+91 98111 22334"); // from the shipping address
    assert.equal(guest.identity.firstName, "Asha");
    assert.equal(guest.identity.location, "Tinsukia, Assam");

    const withCustomer = mapOrder(normalized(orderNode()));
    assert.equal(withCustomer.identity.externalId, "2000000000001");
  });

  it("uses the discount codes as the discount reason", () => {
    assert.equal(mapOrder(normalized(orderNode({ discountCodes: ["WELCOME10", "FREESHIP"] }))).discountReason, "WELCOME10, FREESHIP");
    assert.equal(mapOrder(normalized(orderNode())).discountReason, null);
  });
});

describe("product and customer mapping", () => {
  const product = {
    id: "gid://shopify/Product/5001", title: "Aayush Wellness Herbal Masala", handle: "masala", status: "ACTIVE", vendor: null, productType: null,
    description: "Herbal masala", updatedAt: "2026-09-18T00:00:00Z", variantsTruncated: false,
    variants: [
      { id: "gid://shopify/ProductVariant/6001", title: "Paan Masala Flavour / 60 - Pouches", sku: "AW-HM-PN-60", price: "649.0", updatedAt: "2026-09-17T00:00:00Z" },
      { id: "gid://shopify/ProductVariant/6002", title: "Gutka Flavour / 60 - Pouches", sku: "AW-HM-CR-60", price: "599.5", updatedAt: null },
    ],
  };

  it("maps a product and its variants with Shopify ids, prices and SKUs", () => {
    const p = mapProduct(product);
    assert.equal(p.externalId, "5001");
    assert.equal(p.name, "Aayush Wellness Herbal Masala");
    assert.equal(p.status, ProductStatus.ACTIVE);
    assert.equal(p.basePrice, "599.50");
    assert.deepEqual(p.variants.map((v) => [v.externalId, v.sku, v.price]), [["6001", "AW-HM-PN-60", "649.00"], ["6002", "AW-HM-CR-60", "599.50"]]);
    assert.equal(p.variants[1].externalUpdatedAt.toISOString(), "2026-09-18T00:00:00.000Z"); // falls back to the product's
  });

  it("marks archived and draft products inactive, along with their variants", () => {
    for (const s of ["ARCHIVED", "DRAFT"]) {
      const p = mapProduct({ ...product, status: s });
      assert.equal(p.status, ProductStatus.INACTIVE);
      assert.ok(p.variants.every((v) => v.status === ProductStatus.INACTIVE));
    }
  });

  it("maps a customer, including a location from the default address", () => {
    const c = mapCustomer({ id: "gid://shopify/Customer/77", firstName: "Asha", lastName: "Verma", email: "a@example.com", phone: "+919811122334", createdAt: "2026-01-05T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z", city: "Pune", province: "Maharashtra" });
    assert.equal(c.externalId, "77");
    assert.equal(c.location, "Pune, Maharashtra");
    assert.equal(c.externalUpdatedAt.toISOString(), "2026-09-19T00:00:00.000Z");
  });
});
