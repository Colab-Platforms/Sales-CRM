import { logger } from "@/utils/logger.js";
import type { ShopifyClient } from "./shopify.client.js";
import { listCustomersForDisplay } from "./shopify.customers.js";
import { createShopifyCustomer, fillShopifyCustomerName, setShopifyOrderCustomer } from "./shopify.customers.write.js";
import { classifyOrder, type AuditCrmOrder, type AuditResult, type RepairPlan } from "./shopify.order-audit.js";
import { loadCrmAuditOrders, loadShopifyAuditOrders, type ReadDb } from "./shopify.order-audit.load.js";
import { customerNames, isPhoneTakenError, findCustomerByPhone } from "./shopify.order-customer.js";

// DATA REPAIR of the Shopify CUSTOMER on orders the CRM pushed (the order has no customer, or its customer has no name). It never touches money: no payment, refund, cancellation, fulfilment, shipment, line item,
// price, shipping or discount is read-for-change here, and an order whose total differs between the systems is never repaired by the batch tool (see shopify.order-audit.ts). Each repair:
//   1. re-reads BOTH records right now and re-classifies; if the order is no longer exactly the planned, otherwise-clean case it is SKIPPED (state changed since the dry run);
//   2. finds the customer by the lead's phone: exactly one verified match is reused, none -> a customer is created from the CRM name + phone, more than one -> SKIPPED (never guessed);
//   3. links it with orderCustomerSet (or fills a blank name with customerUpdate - an existing name is never overwritten);
//   4. reads the order back and only then reports success.
// Running it again is safe: an order that already has its customer classifies as clean and is left alone, and a customer the first run created is found by phone, never created twice.
// The same step (fixOrderCustomer) is what the order page's "Sync from CRM" uses for one order.

export type RepairStatus = "repaired" | "skipped" | "failed" | "dry_run";
export interface RepairOutcome {
  crmOrderId: string;
  orderName: string | null;
  plan: RepairPlan;
  status: RepairStatus;
  reason: string;
  /** What was (or in a dry run, would be) changed in Shopify. */
  changes: string[];
}

export interface RepairDeps {
  db: ReadDb;
  client: Pick<ShopifyClient, "query">;
  /** Records the result on the order's history. Optional (a dry run never writes). */
  record?: (crm: AuditCrmOrder, outcome: RepairOutcome) => Promise<void>;
  /** Delay before the second phone lookup after a refused duplicate (0 in tests). */
  retryDelayMs?: number;
}

const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
/** A customer already in Shopify with a name that clearly belongs to someone else (the same phone, a different person) is not reused automatically. */
export const sameFirstName = (crmFirst: string, shopifyName: string | null | undefined): boolean => {
  const a = norm(crmFirst);
  const b = norm(shopifyName);
  return !b || b.includes(a) || a.includes(b.split(" ")[0] ?? "");
};

const skip = (r: AuditResult, reason: string, plan: RepairPlan = r.repair): RepairOutcome => ({ crmOrderId: r.crmOrderId, orderName: r.orderName, plan, status: "skipped", reason, changes: [] });

export interface CustomerFixResult {
  status: RepairStatus;
  reason: string;
  changes: string[];
}

/**
 * The customer part only: link / create the Shopify customer for the order, or fill the blank name of the customer it already has. The caller has already decided the order is in a state where this is allowed.
 * `apply: false` plans without writing. Never touches an amount, payment, line, shipment or fulfilment.
 */
export async function fixOrderCustomer(
  deps: { client: Pick<ShopifyClient, "query">; retryDelayMs?: number },
  input: { plan: "LINK_OR_CREATE_CUSTOMER" | "FILL_CUSTOMER_NAME"; externalId: string; lead: AuditCrmOrder["lead"]; shopifyCustomer: { id: string } | null },
  opts: { apply: boolean },
): Promise<CustomerFixResult> {
  const names = customerNames(input.lead, null);
  const orderGid = `gid://shopify/Order/${input.externalId}`;
  const changes: string[] = [];
  const result = (status: RepairStatus, reason: string): CustomerFixResult => ({ status, reason, changes });
  const readBack = async () => (await loadShopifyAuditOrders(deps.client, [input.externalId])).get(input.externalId);

  if (input.plan === "FILL_CUSTOMER_NAME") {
    const customer = input.shopifyCustomer;
    if (!customer) return result("skipped", "the order has no customer to name");
    changes.push(`set the name of Shopify customer ${customer.id.split("/").pop()} to the CRM name`);
    if (!opts.apply) return result("dry_run", "the order's customer has no name in Shopify");
    await fillShopifyCustomerName(deps.client, customer.id, names);
    const after = await readBack();
    if (!after?.customer || (!after.customer.firstName && !after.customer.lastName)) return result("failed", "Shopify accepted the update but the customer still has no name");
    return result("repaired", "customer name filled");
  }

  const phone = input.lead.normalizedMobile;
  if (!phone) return result("skipped", "the lead has no phone number to match a Shopify customer on");
  const matches = (await listCustomersForDisplay(deps.client as ShopifyClient, { first: 5, search: `phone:"${phone}"` })).items.filter((c) => c.phone && c.phone.replace(/\D/g, "") === phone.replace(/\D/g, ""));
  if (matches.length > 1) return result("skipped", `${matches.length} different Shopify customers have this phone; none was chosen`);
  let customerId: string;
  let needName = false;
  if (matches.length === 1) {
    const only = matches[0]!;
    if (!sameFirstName(input.lead.firstName, only.name)) return result("skipped", "the Shopify customer with this phone has a different name from the CRM customer; left for manual review");
    customerId = only.id;
    needName = !only.name?.trim();
    changes.push(`link the existing Shopify customer ${only.externalId}`);
  } else {
    changes.push("create a Shopify customer from the CRM name and phone, then link it");
    if (!opts.apply) return result("dry_run", "no Shopify customer has this phone");
    try {
      customerId = (await createShopifyCustomer(deps.client, { phone, email: null, ...names })).id;
    } catch (error) {
      if (!isPhoneTakenError(error)) throw error;
      // refused as a duplicate: it exists (made a moment ago, or not yet in the search index) - find it, never create a second one
      const again = await findCustomerByPhone(deps.client, phone, deps.retryDelayMs ?? 1500);
      if (again.length !== 1) return result("failed", again.length === 0 ? "Shopify says the phone already belongs to a customer but it could not be found yet; nothing was linked - run again later" : "more than one Shopify customer has this phone; none was chosen");
      customerId = again[0]!.id;
      needName = !again[0]!.name?.trim();
      changes.push(`(creation was refused as a duplicate; reused customer ${customerId.split("/").pop()})`);
    }
  }
  if (!opts.apply) {
    if (needName) changes.push("fill its blank name");
    return result("dry_run", "an existing verified Shopify customer matches this phone");
  }
  if (needName) {
    await fillShopifyCustomerName(deps.client, customerId, names);
    changes.push("filled its blank name");
  }
  await setShopifyOrderCustomer(deps.client, orderGid, customerId);
  const after = await readBack();
  if (after?.customer?.id !== customerId) return result("failed", "Shopify accepted the link but the order does not show the customer");
  return result("repaired", "customer linked");
}

/** Repairs one order. `expected` is the plan from the dry run; if the live state no longer matches it, nothing is done. */
export async function repairOrderCustomer(deps: RepairDeps, crmOrderId: string, expected: RepairPlan, opts: { apply: boolean }): Promise<RepairOutcome> {
  const crmList = await loadCrmAuditOrders(deps.db, { crmOrderId });
  const crm = crmList[0];
  if (!crm) return { crmOrderId, orderName: null, plan: expected, status: "skipped", reason: "the CRM order is gone or no longer a Shopify-linked telecaller order", changes: [] };
  const shopMap = await loadShopifyAuditOrders(deps.client, [crm.externalId]);
  const shop = shopMap.get(crm.externalId);
  if (!shop) return { crmOrderId, orderName: crm.externalNumber, plan: expected, status: "skipped", reason: "Shopify no longer has this order", changes: [] };

  // 1. re-classify NOW
  const now = classifyOrder(crm, shop);
  if (now.repair !== expected) return skip(now, `state changed since the dry run (was ${expected}, now ${now.repair}${now.reviewReasons.length ? `: ${now.reviewReasons.join("; ")}` : ""})`, expected);
  if (now.repair !== "LINK_OR_CREATE_CUSTOMER" && now.repair !== "FILL_CUSTOMER_NAME") return skip(now, "nothing to repair automatically");

  const done = async (r: CustomerFixResult): Promise<RepairOutcome> => {
    const outcome: RepairOutcome = { crmOrderId, orderName: shop.name, plan: now.repair, status: r.status, reason: r.reason, changes: r.changes };
    if (opts.apply && deps.record && (r.status === "repaired" || r.status === "failed")) {
      try {
        await deps.record(crm, outcome);
      } catch (error) {
        logger.error(`Could not record the repair result on order ${crm.orderNumber}`, error instanceof Error ? error.message : String(error));
      }
    }
    return outcome;
  };
  try {
    const r = await fixOrderCustomer({ client: deps.client, retryDelayMs: deps.retryDelayMs }, { plan: now.repair, externalId: crm.externalId, lead: crm.lead, shopifyCustomer: shop.customer }, opts);
    if (r.status === "skipped") return skip(now, r.reason);
    return await done(r);
  } catch (error) {
    const text = error instanceof Error ? error.message.split("\n").join(" ").slice(0, 300) : "unknown error";
    logger.warn(`Customer repair failed for order ${crm.orderNumber}: ${text}`);
    return await done({ status: "failed", reason: text, changes: [] });
  }
}
