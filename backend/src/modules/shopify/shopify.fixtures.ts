// Test fixtures shaped like the real Shopify orders seen in this store (COD, Cashfree prepaid, RTO, no gateway).
// Used only by tests. Names, phone numbers and ids are invented.
import { normalizeOrder, orderNodeSchema, type NormalizedOrder } from "./shopify.orders.js";

// A made-up token. It only proves that whatever we feed in as a secret never comes back out.
export const TOKEN = "shpat_TEST0123456789abcdefFAKE";
export const ENV = {
  SHOPIFY_STORE_DOMAIN: "demo-store.myshopify.com",
  SHOPIFY_ACCESS_TOKEN: TOKEN,
  SHOPIFY_API_VERSION: "2026-01",
};

export const money = (amount: string) => ({ shopMoney: { amount, currencyCode: "INR" } });

type Raw = Record<string, unknown>;

const lineItem = (overrides: Raw = {}) => ({
  id: "gid://shopify/LineItem/900001",
  title: "Aayush Wellness Herbal Masala",
  variantTitle: "Paan Masala Flavour / 60 - Pouches",
  sku: "AW-HM-PN-60",
  quantity: 1,
  originalUnitPriceSet: money("649.0"),
  discountAllocations: [],
  taxLines: [],
  product: { id: "gid://shopify/Product/5001" },
  variant: { id: "gid://shopify/ProductVariant/6001" },
  ...overrides,
});

/** A raw GraphQL order node: by default a paid Cashfree order that is not yet shipped. */
export const orderNode = (overrides: Raw = {}): Raw => ({
  id: "gid://shopify/Order/1000000000001",
  name: "#TST1001",
  createdAt: "2026-09-19T10:00:00Z",
  updatedAt: "2026-09-19T10:05:00Z",
  processedAt: "2026-09-19T10:00:00Z",
  cancelledAt: null,
  cancelReason: null,
  currencyCode: "INR",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  returnStatus: "NO_RETURN",
  taxesIncluded: true,
  tags: ["Cashfree", "prepaid", "UPI"],
  paymentGatewayNames: ["Cashfree"],
  discountCodes: [],
  email: "asha.verma@example.com",
  phone: null,
  customer: { id: "gid://shopify/Customer/2000000000001", firstName: "Asha", lastName: "Verma", email: "asha.verma@example.com", phone: "+91 98111 22334" },
  shippingAddress: {
    name: "Asha Verma", firstName: "Asha", lastName: "Verma", address1: "12 Park Road", address2: null, city: "Tinsukia", province: "Assam",
    provinceCode: "AS", zip: "786125", country: "India", countryCodeV2: "IN", phone: "+91 98111 22334",
  },
  subtotalPriceSet: money("649.0"),
  totalDiscountsSet: money("0.0"),
  totalTaxSet: money("0.0"),
  totalShippingPriceSet: money("0.0"),
  totalPriceSet: money("649.0"),
  totalRefundedSet: money("0.0"),
  lineItems: { pageInfo: { hasNextPage: false }, nodes: [lineItem()] },
  transactions: [
    { id: "gid://shopify/OrderTransaction/8800001", kind: "SALE", status: "SUCCESS", gateway: "Cashfree", processedAt: "2026-09-19T10:00:30Z", errorCode: null, paymentId: "cf_pay_123", amountSet: money("649.0"), parentTransaction: null },
  ],
  fulfillments: [],
  ...overrides,
});

/** A cash-on-delivery order: payment pending on a COD transaction, shipping charged. */
export const codOrderNode = (overrides: Raw = {}): Raw =>
  orderNode({
    id: "gid://shopify/Order/1000000000002",
    name: "#TST1002",
    displayFinancialStatus: "PENDING",
    tags: ["cash on delivery", "fastrr"],
    paymentGatewayNames: ["Cash on Delivery (COD)"],
    subtotalPriceSet: money("649.0"),
    totalShippingPriceSet: money("50.0"),
    totalPriceSet: money("699.0"),
    transactions: [
      { id: "gid://shopify/OrderTransaction/8800002", kind: "SALE", status: "PENDING", gateway: "Cash on Delivery (COD)", processedAt: "2026-09-19T10:10:40Z", errorCode: null, paymentId: "cod_1", amountSet: money("699.0"), parentTransaction: null },
    ],
    ...overrides,
  });

export const rawTransaction = (overrides: Raw) => ({
  id: "gid://shopify/OrderTransaction/9900001",
  kind: "SALE",
  status: "SUCCESS",
  gateway: "Cashfree",
  processedAt: "2026-09-19T10:00:30Z",
  errorCode: null,
  paymentId: null,
  amountSet: money("649.0"),
  parentTransaction: null,
  ...overrides,
});

export const rawFulfillment = (displayStatus: string, overrides: Raw = {}) => ({
  id: "gid://shopify/Fulfillment/7700001",
  status: "SUCCESS",
  displayStatus,
  createdAt: "2026-09-19T12:00:00Z",
  deliveredAt: displayStatus === "DELIVERED" ? "2026-09-21T09:00:00Z" : null,
  trackingInfo: [{ company: "Shiprocket", number: "SR12345", url: "https://track.example/SR12345" }],
  ...overrides,
});

export const rawLineItem = lineItem;

/** Runs a raw node through the same parsing the client uses. */
export const normalized = (node: Raw): NormalizedOrder => normalizeOrder(orderNodeSchema.parse(node));
