import type { Estimate, PreviewOrder, SyncReport } from "./shopify.sync.js";
import { formatInZone } from "./shopify.window.js";

// Terminal output for the dry run. Personal data is masked, and nothing here can see the access
// token: the config and client are not passed in.

export function maskEmail(email: string | null): string {
  if (!email) return "-";
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const domain = email.slice(at + 1);
  const dot = domain.indexOf(".");
  const host = dot > 0 ? `${domain[0]}***${domain.slice(dot)}` : `${domain[0] ?? ""}***`;
  return `${email[0]}***@${host}`;
}

export function maskPhone(phone: string | null): string {
  if (!phone) return "-";
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `${"*".repeat(Math.max(digits.length - 2, 4))}${digits.slice(-2)}`;
}

export function maskName(firstName: string | null, lastName: string | null): string {
  const first = firstName?.trim();
  const last = lastName?.trim();
  if (!first && !last) return "-";
  return [first, last ? `${last[0]}.` : null].filter(Boolean).join(" ");
}

const money = (currency: string, amount: string | null) => (amount === null ? "-" : `${currency} ${amount}`);

function previewLines({ raw: order, mapped }: PreviewOrder, index: number, total: number): string[] {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const { customer } = order;
  const lines = [
    "",
    `Order ${index + 1} of ${total}`,
    `- Shopify ID: ${order.id}`,
    `- Order: ${order.name}  ->  CRM order number ${mapped.orderNumber}`,
    `- Created: ${order.createdAt}`,
    `- Customer: ${maskName(customer.firstName, customer.lastName)} (${customer.source === "customer" ? customer.id : `no customer record; contact from ${customer.source}`})`,
    `- Email: ${maskEmail(customer.email)}   Phone: ${maskPhone(customer.phone)}`,
    `- Ship to pincode: ${mapped.shippingPincode ?? "-"}`,
    `- Items: ${order.items.length} (${units} units)${order.itemsTruncated ? " - MORE LINE ITEMS EXIST THAN WERE FETCHED" : ""}`,
  ];
  for (const item of order.items) {
    const variant = item.variantTitle && item.variantTitle !== "Default Title" ? ` / ${item.variantTitle}` : "";
    lines.push(`    - ${item.title}${variant} | SKU ${item.sku ?? "-"} | ${item.quantity} x ${money(order.currency, item.unitPrice)}`);
  }
  lines.push(
    `- Subtotal ${money(order.currency, mapped.subtotal)} | Discount ${money(order.currency, mapped.discountAmount)} | Tax ${money(order.currency, mapped.taxAmount)} | Shipping ${money(order.currency, mapped.shippingAmount)} | Total ${money(order.currency, mapped.totalAmount)}`,
    `- Shopify says: financial ${order.financialStatus ?? "-"}, fulfillment ${order.fulfillmentStatus ?? "-"}, gateways ${order.paymentGateways.join(", ") || "-"}`,
    `- CRM order status: ${mapped.status}   Payment mode: ${(mapped.metadata as { paymentMode?: string | null }).paymentMode ?? "unknown"}`,
    `- CRM payments: ${mapped.payments.map((p) => `${p.status}${p.method ? `/${p.method}` : ""} ${p.amount}`).join("; ") || "none"}`,
  );
  for (const warning of mapped.warnings) lines.push(`- WARNING: ${warning}`);
  return lines;
}

const counts = (c: { created: number; updated: number; skipped: number; failed: number }) =>
  `created ${c.created} | updated ${c.updated} | skipped ${c.skipped} | failed ${c.failed}`;

const RELEVANT_SCOPES = ["read_orders", "read_customers", "read_products", "read_all_orders"];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const estimateText = (e: Estimate) => `${e.kind === "upTo" ? "up to " : e.exact ? "" : "at least "}${e.count}${e.kind === "matching" && e.exact ? " (exact)" : ""}`;

function windowLines(report: SyncReport, limit: number | null): string[] {
  const { window } = report;
  if (!window) return [];
  const zone = window.timeZone;
  const lines = [
    `Window: orders created ${formatInZone(window.createdFrom, zone)} -> ${formatInZone(window.createdTo, zone)} (${zone})`,
    `        = ${window.createdFrom.toISOString()} -> ${window.createdTo.toISOString()}`,
  ];
  if (window.updatedSince) lines.push(`Incremental: only records changed in Shopify since ${formatInZone(window.updatedSince, zone)} (${zone})`);

  const { estimate } = report;
  const parts = [
    estimate.orders && `Orders ${estimateText(estimate.orders)}`,
    estimate.customers && `Customers ${estimateText(estimate.customers)}`,
    estimate.products && `Products ${estimateText(estimate.products)}`,
  ].filter(Boolean);
  if (parts.length > 0) lines.push(`Matching in Shopify: ${parts.join(" | ")}`);
  if (estimate.orders?.kind === "matching") {
    const total = estimate.orders.count;
    const thisRun = limit === null ? total : Math.min(limit, total);
    lines.push(`This run: ${plural(thisRun, "order")}${limit === null ? " (--all)" : ` (--limit ${limit})`}; ${total - thisRun} more in the window${total - thisRun > 0 ? " - add --all to import them" : ""}`);
  }
  return lines;
}

export function renderReport(report: SyncReport, apiVersion: string, storeDomain: string, limit: number | null = null): string[] {
  const lines: string[] = [];
  const mode = report.dryRun ? "dry run (nothing is written)" : "sync";

  lines.push(`Shopify connection: ${report.connection ? "PASS" : "FAIL"}`);
  lines.push(`Mode: ${mode}`);
  lines.push(`Store: ${report.connection ? `${report.connection.storeDomain} (${report.connection.shopName})` : storeDomain}`);
  lines.push(`API version: ${apiVersion}`);

  if (report.scopes) {
    const have = RELEVANT_SCOPES.filter((s) => report.scopes!.granted.includes(s));
    lines.push(`Scopes used: ${have.join(", ") || "(none of the needed ones)"}  (${report.scopes.granted.length} granted in total)`);
    lines.push(`Missing scopes: ${report.scopes.missing.join(", ") || "none"}`);
    lines.push(`Historical orders (older than 60 days): ${report.scopes.historicalOrders ? "read_all_orders granted" : "read_all_orders NOT granted - only the last 60 days are readable"}`);
    if (report.scopes.unneededWrite.length > 0) {
      lines.push(`Note: the token also holds ${report.scopes.unneededWrite.length} write scopes this one-way integration does not need (least privilege).`);
    }
  }

  lines.push(...windowLines(report, limit));

  if (report.error) {
    lines.push("", "Result: FAIL");
    lines.push(...report.error.message.split("\n").map((line, i) => (i === 0 ? `Reason: ${line}` : line)));
  }

  if (report.dryRun) {
    lines.push(`Orders fetched: ${report.preview.length}`);
    if (!report.error && report.preview.length === 0) lines.push("No orders were returned (authentication itself worked).");
  } else if (report.connection) {
    lines.push(`Orders:    ${counts(report.counts.orders)}`);
    lines.push(`Products:  ${counts(report.counts.products)}`);
    lines.push(`Variants:  created ${report.variants.created} | updated ${report.variants.updated} | skipped ${report.variants.skipped}`);
    lines.push(`Customers: ${counts(report.counts.customers)}`);
    lines.push(`Leads:     created ${report.leads.created} | matched existing ${report.leads.matched} | filled in ${report.leads.updated}`);
    lines.push(`Payments:  created ${report.payments.created} | updated ${report.payments.updated} | removed ${report.payments.deleted}`);
  }
  lines.push(`Database writes: ${report.databaseWrites}`);
  if (report.connection) lines.push(`Elapsed: ${(report.elapsedMs / 1000).toFixed(1)}s`);

  if (report.failures.length > 0) {
    lines.push("", `Failures (${report.failures.length}):`);
    report.failures.slice(0, 10).forEach((f) => lines.push(`  - ${f.resource} ${f.ref}: ${f.reason}`));
  }
  if (report.warnings.length > 0) {
    lines.push("", `Warnings (${report.warnings.length}):`);
    report.warnings.slice(0, 10).forEach((w) => lines.push(`  - ${w}`));
  }
  if (report.dryRun) report.preview.forEach((p, i) => lines.push(...previewLines(p, i, report.preview.length)));
  return lines;
}
