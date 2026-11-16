// READ-ONLY verification of ONE CRM order's payment across CRM, Shopify and Shiprocket, for the controlled release check.
//   npm run order:verify-payment -- CRM-XXXXXXXX-XXXX
// Reads the CRM database, one Shopify order query and Shiprocket GET /orders only. It writes nothing and prints no customer data (order numbers, amounts, statuses, times).
// PREPAID order: expects ONE successful SALE transaction recorded when Shopify created the order, no second payment, Shopify PAID with nothing outstanding, Shiprocket Prepaid.
// COD order: expects no payment transaction, Shopify PENDING with the full total outstanding, Shiprocket COD for that amount.
import "dotenv/config";
import { prisma } from "../lib/prisma.js";
import { ShopifyClient } from "../modules/shopify/shopify.client.js";
import { loadShopifyConfig } from "../modules/shopify/shopify.config.js";
import { ShiprocketClient } from "../modules/shiprocket/shiprocket.client.js";
import { loadShiprocketConfig } from "../modules/shiprocket/shiprocket.config.js";

const ref = process.argv[2];
if (!ref) {
  console.error("usage: npm run order:verify-payment -- <CRM order number>");
  process.exit(2);
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

const order = await prisma.order.findFirst({
  where: { orderNumber: ref },
  select: { orderNumber: true, externalNumber: true, externalId: true, status: true, totalAmount: true, metadata: true, payments: { select: { status: true, method: true, provider: true } } },
});
if (!order) throw new Error("No CRM order with that number");
const meta = (order.metadata ?? {}) as Record<string, any>;
const mode = String(meta.paymentMode ?? "").toUpperCase();
const total = Number(order.totalAmount);
check("CRM order is linked to a Shopify order", Boolean(order.externalId && order.externalNumber), String(order.externalNumber ?? "not linked"));
if (!order.externalId || !order.externalNumber) {
  console.table(checks);
  await prisma.$disconnect();
  process.exit(1);
}

const shopify = new ShopifyClient(loadShopifyConfig(process.env));
const gid = /^gid:/.test(order.externalId) ? order.externalId : `gid://shopify/Order/${order.externalId}`;
const data = await shopify.query<{ order: Record<string, any> | null }>(
  `query($id:ID!){ order(id:$id){ name createdAt cancelledAt displayFinancialStatus fullyPaid paymentGatewayNames tags totalPriceSet{shopMoney{amount}} totalReceivedSet{shopMoney{amount}} totalOutstandingSet{shopMoney{amount}} transactions(first:20){ kind status gateway createdAt amountSet{shopMoney{amount}} } } }`,
  { id: gid },
);
const s = data.order;
if (!s) throw new Error("Shopify has no such order");
const sales = (s.transactions ?? []).filter((t: any) => t.kind === "SALE");
const received = Number(s.totalReceivedSet?.shopMoney?.amount ?? 0);
const outstanding = Number(s.totalOutstandingSet?.shopMoney?.amount ?? 0);

console.log(`CRM ${order.orderNumber} (${mode || "unknown mode"}) -> Shopify ${s.name}; Shopify status ${s.displayFinancialStatus}; created ${s.createdAt}`);
if (mode === "PREPAID") {
  const first = sales[0];
  const lag = first ? (Date.parse(first.createdAt) - Date.parse(s.createdAt)) / 1000 : null;
  check("CRM payment is verified (SUCCESS)", order.payments.some((p) => p.status === "SUCCESS"));
  check("Shopify financial status is PAID", s.displayFinancialStatus === "PAID", String(s.displayFinancialStatus));
  check("exactly ONE SALE transaction (no second payment call)", sales.length === 1, `${sales.length} SALE`);
  check("the SALE transaction is SUCCESS for the CRM total", sales.length === 1 && first.status === "SUCCESS" && Number(first.amountSet.shopMoney.amount) === total, first ? `${first.status} ${first.amountSet.shopMoney.amount} via ${first.gateway}` : "none");
  check("the transaction was recorded AT creation (within 3 s of the order)", lag !== null && lag <= 3, lag === null ? "no transaction" : `${lag} s`);
  check("nothing outstanding in Shopify", outstanding === 0 && received === total, `received ${received}, outstanding ${outstanding}`);
  check("CRM recorded it as created paid (no mark-as-paid)", Boolean(meta.shopifyPaidAtCreation), meta.shopifyPaymentSync?.performed ?? "(shopifyPaymentSync not recorded)");
} else if (mode === "COD") {
  check("no payment transaction in Shopify", sales.length === 0, `${sales.length} SALE`);
  check("Shopify is NOT paid", s.displayFinancialStatus !== "PAID", String(s.displayFinancialStatus));
  check("the full total is outstanding in Shopify", outstanding === total, `outstanding ${outstanding} of ${total}`);
} else {
  check("CRM payment mode is known", false, mode || "missing");
}

// Shiprocket's Shopify-channel order for the same Shopify order name (exact reference, never a phone number).
const sr = loadShiprocketConfig(process.env);
if (!sr) throw new Error("Shiprocket is not configured");
const client = new ShiprocketClient(sr as never);
const found = (await client.findOrdersByChannelId(String(order.externalNumber))).filter((o) => o.channelOrderId.replace(/^#/, "") === String(order.externalNumber).replace(/^#/, ""));
check("Shiprocket has exactly one order for this Shopify order", found.length === 1, `${found.length} found (Shiprocket imports can take a few minutes: rerun)`);
if (found.length === 1) {
  const o = found[0]!;
  const pm = String(o.paymentMethod ?? "").toUpperCase();
  if (mode === "PREPAID") {
    check("Shiprocket payment mode is Prepaid", pm === "PREPAID", pm);
    check("Shiprocket shows no COD to collect (see the Shiprocket order page: COD amount 0)", pm === "PREPAID", "payment mode Prepaid carries no COD amount");
  } else if (mode === "COD") {
    check("Shiprocket payment mode is COD", pm === "COD", pm);
    check("Shiprocket COD amount equals the outstanding amount", o.totalCents !== null && o.totalCents === Math.round(outstanding * 100), `Shiprocket ${o.totalCents === null ? "?" : o.totalCents / 100}, outstanding ${outstanding}`);
  }
}

console.table(checks.map((c) => ({ result: c.ok ? "PASS" : "FAIL", check: c.name, detail: c.detail })));
const failed = checks.filter((c) => !c.ok).length;
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
