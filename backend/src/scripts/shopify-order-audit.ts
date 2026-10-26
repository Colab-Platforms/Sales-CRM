import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prisma } from "../lib/prisma.js";
import { ShopifyClient } from "../modules/shopify/shopify.client.js";
import { loadShopifyConfig } from "../modules/shopify/shopify.config.js";
import { classifyOrder, crmHasCustomerName, type AuditResult } from "../modules/shopify/shopify.order-audit.js";
import { loadCrmAuditOrders, loadShopifyAuditOrders } from "../modules/shopify/shopify.order-audit.load.js";

// READ-ONLY audit: every CRM telecaller order that was pushed to Shopify, matched to its Shopify order by the stable Shopify order id (never by name), compared on money and on the customer.
// The database is read inside a READ ONLY transaction and Shopify is only queried. Usage: npm run shopify:audit -- --out <file.json>
// The JSON file holds customer names (needed to plan repairs) - keep it out of the repository. The console shows counts and order numbers only.

const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
const crmOrders = await loadCrmAuditOrders(prisma as never);
console.log(`CRM telecaller orders linked to Shopify: ${crmOrders.length}`);
const shop = await loadShopifyAuditOrders(new ShopifyClient(loadShopifyConfig(process.env)), crmOrders.map((o) => o.externalId), (n) => { if (n % 400 === 0) console.error(`... ${n} read from Shopify`); });

type Row = AuditResult & { crmOrderNumber: string; created: string; paymentStatus: string; fulfilment: string | null; shopifyFinancial: string | null; crmCustomerName: string; shopifyCustomer: string; shopifyCustomerId: string | null; leadId: string; phone: string | null; hasEmail: boolean };
const report: Row[] = [];
const missingInShopify: string[] = [];
for (const crm of crmOrders) {
  const s = shop.get(crm.externalId);
  if (!s) { missingInShopify.push(crm.orderNumber); continue; }
  report.push({
    ...classifyOrder(crm, s), crmOrderNumber: crm.orderNumber, created: crm.createdAt, paymentStatus: crm.paymentStatuses.join("+") || "NONE", fulfilment: s.fulfillmentStatus, shopifyFinancial: s.financialStatus,
    crmCustomerName: crmHasCustomerName(crm.lead) ? [crm.lead.firstName, crm.lead.lastName].filter(Boolean).join(" ") : "(no real name)",
    shopifyCustomer: s.customer ? (s.customer.firstName || s.customer.lastName ? "linked, named" : "linked, NO NAME") : "NOT LINKED", shopifyCustomerId: s.customer?.id ?? null, leadId: crm.lead.id, phone: crm.lead.normalizedMobile, hasEmail: Boolean(crm.lead.email),
  });
}
const count = (f: (r: Row) => boolean) => report.filter(f).length;
console.log(JSON.stringify({
  compared: report.length, notFoundInShopify: missingInShopify.length, clean: count((r) => !r.money && !r.customerIssue),
  moneyMismatch: count((r) => Boolean(r.money)), moneyByKind: Object.fromEntries([...new Set(report.map((r) => r.money?.kind).filter(Boolean))].map((k) => [k, count((r) => r.money?.kind === k)])),
  customerIssue: { noCustomer: count((r) => r.customerIssue === "NO_CUSTOMER"), nameMissing: count((r) => r.customerIssue === "CUSTOMER_NAME_MISSING") },
  repairPlan: Object.fromEntries(["NONE", "LINK_OR_CREATE_CUSTOMER", "FILL_CUSTOMER_NAME", "MANUAL_REVIEW"].map((k) => [k, count((r) => r.repair === k)])),
}));
console.log("money mismatches:", report.filter((r) => r.money).map((r) => `${r.orderName} diff ${(r.differenceCents / 100).toFixed(2)} ${r.money!.kind} [${r.reviewReasons.join("; ")}]`).join(" | "));
if (missingInShopify.length) console.log("CRM orders whose Shopify order was not found:", missingInShopify.join(", "));
if (out) writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), report, missingInShopify }, null, 1));
await prisma.$disconnect();
