// Which order id a CRM-created order is registered under in Shiprocket.
//
//   1 CRM order = 1 Shopify order = 1 Shiprocket shipment.
//
// When the order is (or is about to be) a Shopify order, Shiprocket must carry the SHOPIFY order reference (e.g. AWL110598) as its order id - the same id the store's Shopify-Shiprocket channel would use - so the
// two routes into Shiprocket can never produce two different orders for one sale. The CRM order number stays on the CRM side (Shipment.channelOrderId + Order.metadata.shiprocketSync) and in the Shiprocket
// order's comment, for mapping and reconciliation. Pure functions only.
import { storedShopifySyncDecision } from "../settings/shopify-sync.setting.js";

export interface ChannelRefOrder {
  source: string;
  orderNumber: string;
  externalId: string | null;
  externalNumber: string | null;
  metadata: unknown;
}

export type ChannelRefDecision =
  /** The order is linked to Shopify: Shiprocket gets the Shopify order reference. */
  | { kind: "SHOPIFY"; base: string; shopifyOrderId: string; shopifyOrderName: string }
  /** Not (and never going to be) a Shopify order from the CRM's side: the CRM order number, exactly as before. */
  | { kind: "CRM"; base: string }
  /** Shopify sync is ON for this CRM order but its Shopify order does not exist yet: nothing may be sent to Shiprocket until it does. */
  | { kind: "WAIT_FOR_SHOPIFY"; reason: string };

/** "#AWL110598" -> "AWL110598": the form Shiprocket's own Shopify channel stores as channel_order_id. */
export const bareShopifyName = (name: string): string => name.replace(/^#/, "").trim();

export function decideChannelRef(order: ChannelRefOrder): ChannelRefDecision {
  if (order.source !== "SALESPERSON") return { kind: "CRM", base: order.orderNumber }; // a Shopify-originated order keeps the id it always had
  if (order.externalId) {
    const name = bareShopifyName(order.externalNumber ?? "");
    if (!name) return { kind: "WAIT_FOR_SHOPIFY", reason: "The Shopify order is linked but its order number is not known yet - re-sync the Shopify order first." };
    return { kind: "SHOPIFY", base: name, shopifyOrderId: order.externalId, shopifyOrderName: order.externalNumber!.trim() };
  }
  // Not linked. Only an order whose SAVED decision is "Shopify sync ON" is waiting for Shopify; sync OFF (or an order created before the setting existed) is Shiprocket-only, as before.
  if (storedShopifySyncDecision(order.metadata)?.enabled === true) return { kind: "WAIT_FOR_SHOPIFY", reason: "Shopify sync is ON: the order is sent to Shiprocket once its Shopify order exists." };
  return { kind: "CRM", base: order.orderNumber };
}

/** The Shiprocket order id for this submission: the base itself the first time, a suffixed variant after an earlier (cancelled / failed) attempt so two Shiprocket orders never share an id. Max 50 characters. */
export const channelOrderIdFor = (base: string, earlierAttempts: number, uniqueSuffix: string): string => (earlierAttempts === 0 ? base : `${base}-${uniqueSuffix}`).slice(0, 50);
