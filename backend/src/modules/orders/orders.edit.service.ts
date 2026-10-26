import { prisma } from "@/lib/prisma.js";
import { getLeadScope, getManagerTeam, type DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { ActivitySource, ActivityType, OrderStatus, PaymentStatus, ProductStatus, Role } from "../../../generated/prisma/enums.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "../shopify/shopify.config.js";
import { toCents } from "../shopify/shopify.money.js";
import { INDIAN_PROVINCE_CODES, mapAddress, provinceCodeFor, type CrmOrderForShopify, type MappingReport } from "../shopify/shopify.order-mapping.js";
import { readEditableOrder, readVariant, ShopifyOrderEditError, swapOrderLineVariant, updateOrderShippingAddress } from "../shopify/shopify.orders.edit.js";
import { orderActionWhere } from "./orders.filters.js";
import { withOrderEditClaim } from "./orders.claim.js";

// CHANGING AN EXISTING ORDER: the customer asks for another flavour, or another delivery address, after ordering.
//
// Rules, all enforced here on the server (the UI only mirrors them):
//  - WHO: Admin, Manager and Telecaller, and only on orders they may act on (the same scope as cancelling an order).
//  - WHEN: the order must still be open (pending payment / confirmed / processing), have NO shipment, and - when it is linked to Shopify - be unfulfilled and not cancelled in Shopify itself. Shopify's own answer is
//    read first; nothing is assumed from the CRM status.
//  - FLAVOUR: only another ACTIVE variant of the SAME product, linked to Shopify when the order is. The unit price must be EXACTLY the same: a different price would need an extra charge or a refund, which this
//    action never does (no payment is created, collected, refunded or marked) - it is refused with an explanation and the order is left untouched.
//  - ORDER OF WRITES: Shopify first (the supported order-edit workflow / orderUpdate, read back and verified), then the CRM. If Shopify refuses, the CRM is NOT changed and the error is reported. If the CRM write fails
//    after Shopify succeeded, repeating the action finishes the CRM side (it recognises Shopify already holds the change) - so no duplicate edit is ever made and no second order or payment is created.
//  - AUDIT: every change is recorded on the order's history (who, what, before / after).

const STRUCTURED_KEYS = ["houseNumber", "building", "area", "street"] as const;
const EDITABLE_STATUSES: OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.CONFIRMED, OrderStatus.PROCESSING];
const money = (cents: number) => (cents / 100).toFixed(2);
const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

const EDIT_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  currency: true,
  externalId: true,
  externalNumber: true,
  leadId: true,
  subtotal: true,
  discountAmount: true,
  shippingAmount: true,
  taxAmount: true,
  totalAmount: true,
  shippingAddress: true,
  shippingPincode: true,
  metadata: true,
  lead: { select: { firstName: true, lastName: true, leadNumber: true, email: true, normalizedMobile: true, mobile: true } },
  items: { select: { id: true, itemType: true, productId: true, variantId: true, quantity: true, unitPrice: true, productNameSnapshot: true, variantNameSnapshot: true, skuSnapshot: true, variant: { select: { externalId: true, externalSource: true } } }, orderBy: { id: "asc" as const } },
  shipments: { select: { id: true, status: true } },
  payments: { select: { status: true } },
} satisfies Prisma.OrderSelect;
type EditOrder = Prisma.OrderGetPayload<{ select: typeof EDIT_SELECT }>;

export interface FlavourOption { variantId: string; name: string; sku: string | null; priceMatches: boolean; linkedToShopify: boolean; current: boolean }
export interface FlavourLine { itemId: string; productName: string; currentVariantId: string | null; currentVariantName: string | null; quantity: number; unitPrice: string; options: FlavourOption[] }
export interface FlavourListing { editable: boolean; reason: string | null; lines: FlavourLine[] }
export interface EditResult { shopify: "updated" | "not_linked" | "already_applied"; message: string }

export class OrderEditService {
  constructor(
    private readonly db: DbClient = prisma,
    private readonly getShopifyClient: () => Pick<ShopifyClient, "query"> = () => new ShopifyClient(loadShopifyConfig()),
  ) {}

  private assertRole(user: AuthUser): void {
    if (user.role !== Role.ADMIN && user.role !== Role.MANAGER && user.role !== Role.SALESPERSON) throw new ApiError("You do not have permission to edit orders", STATUS_CODES.FORBIDDEN);
  }

  private async load(user: AuthUser, orderId: string): Promise<EditOrder> {
    this.assertRole(user);
    const leadScope = await getLeadScope(user, this.db);
    const team = user.role === Role.MANAGER ? await getManagerTeam(user.id, this.db) : undefined;
    const order = await this.db.order.findFirst({ where: orderActionWhere(user, orderId, leadScope, team?.members.map((m) => m.id) ?? []), select: EDIT_SELECT });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    return order;
  }

  /**
   * ONE edit at a time per order (flavour and address share the claim), the same pattern as the Shopify push claim: a conditional UPDATE on the order row, so it holds across requests and processes. A second
   * request while one is running is refused (409) instead of opening a second Shopify edit session. The claim is released on success, on every error and exception; one left behind by a dead process expires
   * after the lease. The order is re-read AFTER the claim, so the checks and the edit see what the previous edit left.
   */
  private async withClaim<T>(user: AuthUser, orderId: string, work: (order: EditOrder) => Promise<T>): Promise<T> {
    await this.load(user, orderId); // role, scope and "not found" are decided before anything is claimed
    return withOrderEditClaim(this.db, orderId, async () => work(await this.load(user, orderId)));
  }

  /** The CRM-side reasons the order cannot be edited (null = open for editing, subject to Shopify's own answer). */
  private crmBlock(order: EditOrder, what: "flavour" | "address"): string | null {
    if (!EDITABLE_STATUSES.includes(order.status)) return `This order is ${order.status.toLowerCase().replace(/_/g, " ")}, so its ${what} can no longer be changed.`;
    if (order.shipments.length > 0) {
      return what === "address"
        ? "A shipment has already been created for this order, so the delivery address cannot be changed here. The shipment must be corrected with the courier (Shiprocket) separately."
        : "A shipment has already been created for this order, so the flavour cannot be changed here.";
    }
    if (order.payments.some((p) => p.status === PaymentStatus.REFUNDED || p.status === PaymentStatus.PARTIALLY_REFUNDED)) return "This order has a refund recorded, so it cannot be edited here.";
    return null;
  }

  private shopifyClient(): Pick<ShopifyClient, "query"> {
    try {
      return this.getShopifyClient();
    } catch (error) {
      if (error instanceof ShopifyConfigError) throw new ApiError("Shopify is not configured, so this order cannot be updated in Shopify. Nothing was changed.", STATUS_CODES.SERVICE_UNAVAILABLE);
      throw error;
    }
  }

  /** Shopify's own restrictions, read live: a cancelled or (partly) fulfilled order is not edited. */
  private async assertShopifyOpen(client: Pick<ShopifyClient, "query">, shopifyOrderId: string) {
    let live;
    try {
      live = await readEditableOrder(client, shopifyOrderId);
    } catch (error) {
      throw this.shopifyFailure(error, "read the order from Shopify");
    }
    if (live.cancelledAt) throw new ApiError("This order is cancelled in Shopify, so it cannot be edited.", STATUS_CODES.CONFLICT);
    if (live.fulfillmentStatus && live.fulfillmentStatus !== "UNFULFILLED") {
      throw new ApiError(`Shopify shows this order as ${live.fulfillmentStatus.toLowerCase().replace(/_/g, " ")}, so it can no longer be edited.`, STATUS_CODES.CONFLICT);
    }
    return live;
  }

  private shopifyFailure(error: unknown, doing: string): ApiError {
    if (error instanceof ApiError) return error;
    const text = error instanceof Error ? error.message.split("\n").join(" ").slice(0, 300) : "unknown error";
    const scope = /access|scope|permission|write_order_edits|not approved/i.test(text) ? " The Shopify app may be missing the order-editing permission." : "";
    return new ApiError(`Shopify did not ${doing}: ${text}.${scope} Nothing was changed in the CRM.`, 502);
  }

  private async audit(orderId: string, leadId: string, user: AuthUser, title: string, oldValue: unknown, newValue: unknown) {
    await this.db.activity.create({
      data: { leadId, orderId, actorId: user.id, actorRole: user.role, type: ActivityType.NOTE, referenceType: "Order", referenceId: orderId, source: ActivitySource.USER, title, oldValue: oldValue as Prisma.InputJsonValue, newValue: newValue as Prisma.InputJsonValue },
    });
  }

  // ------------------------------------------------------------------------------------------------ flavour
  /** The flavours each catalogue line can be switched to, and whether the order may be edited at all. */
  async listFlavours(user: AuthUser, orderId: string): Promise<FlavourListing> {
    const order = await this.load(user, orderId);
    const reason = this.crmBlock(order, "flavour");
    const lines: FlavourLine[] = [];
    for (const item of order.items) {
      if (item.itemType !== "CATALOG" || !item.productId) continue;
      const variants = await this.db.productVariant.findMany({ where: { productId: item.productId, status: ProductStatus.ACTIVE }, orderBy: { name: "asc" }, select: { id: true, name: true, sku: true, price: true, externalId: true, externalSource: true } });
      lines.push({
        itemId: item.id,
        productName: item.productNameSnapshot,
        currentVariantId: item.variantId,
        currentVariantName: item.variantNameSnapshot,
        quantity: item.quantity,
        unitPrice: item.unitPrice.toString(),
        options: variants.map((v) => ({ variantId: v.id, name: v.name, sku: v.sku, priceMatches: v.price !== null && toCents(v.price.toString()) === toCents(item.unitPrice.toString()), linkedToShopify: v.externalSource === "SHOPIFY" && Boolean(v.externalId), current: v.id === item.variantId })),
      });
    }
    return { editable: reason === null, reason, lines };
  }

  async changeFlavour(user: AuthUser, orderId: string, itemId: string, variantId: string): Promise<EditResult> {
    return this.withClaim(user, orderId, (order) => this.applyFlavour(user, order, itemId, variantId));
  }

  private async applyFlavour(user: AuthUser, order: EditOrder, itemId: string, variantId: string): Promise<EditResult> {
    const blocked = this.crmBlock(order, "flavour");
    if (blocked) throw new ApiError(blocked, STATUS_CODES.CONFLICT);
    const item = order.items.find((i) => i.id === itemId);
    if (!item || item.itemType !== "CATALOG" || !item.productId) throw new ApiError("That line is not a catalogue product, so it has no flavours to switch.", STATUS_CODES.BAD_REQUEST);

    // The new flavour is looked up in the CRM catalogue by id and must belong to THIS product - never derived from a display name.
    const variant = await this.db.productVariant.findFirst({ where: { id: variantId, productId: item.productId, status: ProductStatus.ACTIVE }, select: { id: true, name: true, sku: true, price: true, externalId: true, externalSource: true } });
    if (!variant) throw new ApiError("That flavour is not an available variant of this product.", STATUS_CODES.BAD_REQUEST);

    const oldUnit = toCents(item.unitPrice.toString());
    const alreadyCrm = item.variantId === variant.id;
    if (variant.price === null) throw new ApiError("The new flavour has no price in the catalogue, so the order total cannot be checked. Nothing was changed.", STATUS_CODES.CONFLICT);
    const newUnit = toCents(variant.price.toString());
    if (newUnit !== oldUnit) {
      const delta = (newUnit - oldUnit) * item.quantity;
      throw new ApiError(
        `That flavour is priced differently (${money(newUnit)} per unit instead of ${money(oldUnit)}), which would ${delta > 0 ? `add ${money(delta)} to` : `take ${money(-delta)} off`} the order. Changing the price needs an extra payment or a refund, which this action does not do. Nothing was changed.`,
        STATUS_CODES.CONFLICT,
      );
    }

    let shopify: EditResult["shopify"] = "not_linked";
    if (order.externalId) {
      if (variant.externalSource !== "SHOPIFY" || !variant.externalId) throw new ApiError("The new flavour is not linked to a Shopify variant, so the Shopify order cannot be updated. Nothing was changed.", STATUS_CODES.CONFLICT);
      if (!item.variant?.externalId && !alreadyCrm) throw new ApiError("The current flavour is not linked to a Shopify variant, so the matching Shopify line cannot be found. Nothing was changed.", STATUS_CODES.CONFLICT);
      const client = this.shopifyClient();
      const live = await this.assertShopifyOpen(client, order.externalId);
      const newGid = `gid://shopify/ProductVariant/${variant.externalId}`;
      const oldGid = item.variant?.externalId ? `gid://shopify/ProductVariant/${item.variant.externalId}` : null;
      const oldLine = oldGid ? live.lines.find((l) => l.variantId === oldGid && l.quantity === item.quantity) : undefined;
      const newLine = live.lines.find((l) => l.variantId === newGid && l.quantity === item.quantity);
      if (oldLine && oldGid && oldGid !== newGid) {
        // The new variant must belong to the same Shopify product as the line it replaces, and Shopify's own price for it must equal the line's unit price.
        let info;
        try {
          info = await readVariant(client, newGid);
        } catch (error) {
          throw this.shopifyFailure(error, "read the new flavour");
        }
        if (!info) throw new ApiError("Shopify does not have the new flavour. Nothing was changed.", STATUS_CODES.CONFLICT);
        if (oldLine.productId && info.productId !== oldLine.productId) throw new ApiError("The new flavour belongs to a different Shopify product. Nothing was changed.", STATUS_CODES.CONFLICT);
        if (info.priceCents !== oldLine.unitPriceCents) {
          throw new ApiError(`Shopify prices the new flavour at ${money(info.priceCents)} per unit but this order line is ${money(oldLine.unitPriceCents)}; changing it would change the total, so it was not applied. Nothing was changed.`, STATUS_CODES.CONFLICT);
        }
        try {
          await swapOrderLineVariant(client, order.externalId, { lineItemId: oldLine.id, oldVariantId: oldGid, newVariantId: newGid, quantity: item.quantity, expectedTotalCents: live.totalCents, staffNote: `Flavour changed in the CRM (${order.orderNumber}) by ${user.username}` });
        } catch (error) {
          throw this.shopifyFailure(error instanceof ShopifyOrderEditError ? error : error, "change the flavour");
        }
        shopify = "updated";
      } else if (newLine) {
        shopify = "already_applied"; // a repeat of a change Shopify already holds: only the CRM side is finished
      } else {
        throw new ApiError("The order in Shopify no longer matches this line (its flavour or quantity differs), so it was not changed. Refresh the order and try again.", STATUS_CODES.CONFLICT);
      }
    }

    if (!alreadyCrm) {
      try {
        await this.db.orderItem.update({ where: { id: item.id }, data: { variantId: variant.id, variantNameSnapshot: variant.name, skuSnapshot: variant.sku } });
        await this.audit(order.id, order.leadId, user, `Flavour changed on ${order.externalNumber ?? order.orderNumber}`, { itemId: item.id, variant: item.variantNameSnapshot, sku: item.skuSnapshot }, { itemId: item.id, variant: variant.name, sku: variant.sku, shopify });
      } catch (error) {
        logger.error(`Flavour change: Shopify ${shopify} but the CRM write failed for order ${order.orderNumber}`, error instanceof Error ? error.message : String(error));
        throw new ApiError("The flavour was changed in Shopify but saving it in the CRM failed. Repeat the change - it will finish the CRM side without editing Shopify again.", 500);
      }
    }
    const where = shopify === "not_linked" ? "in the CRM (the order is not linked to Shopify)" : "in the CRM and in Shopify";
    return { shopify, message: alreadyCrm ? "The order already has that flavour." : `Flavour changed to ${variant.name} ${where}. The order total is unchanged at ${money(toCents(order.totalAmount.toString()))}.` };
  }

  // ------------------------------------------------------------------------------------------------ address
  async updateAddress(user: AuthUser, orderId: string, input: Record<string, string | undefined>): Promise<EditResult & { address: Record<string, unknown> }> {
    return this.withClaim(user, orderId, (order) => this.applyAddress(user, order, input));
  }

  private async applyAddress(user: AuthUser, order: EditOrder, input: Record<string, string | undefined>): Promise<EditResult & { address: Record<string, unknown> }> {
    const blocked = this.crmBlock(order, "address");
    if (blocked) throw new ApiError(blocked, STATUS_CODES.CONFLICT);

    // Merge onto the stored address so details the form does not edit (house number, landmark, delivery instructions, address type) are kept unless replaced.
    const before = asRecord(order.shippingAddress);
    const next: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(input)) if (value !== undefined) next[key] = value;
    // The structured parts (house number, building, area, street) are what the NEXT order form is pre-filled from. When the address lines are edited they no longer describe the address, so they are dropped
    // unless this edit supplies them - an old "Flat 7" must never reappear on a new address. Edits that leave the lines alone (name, phone, landmark ...) keep them.
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const linesChanged = (["line1", "line2"] as const).some((k) => input[k] !== undefined && text(input[k]) !== text(before[k]));
    if (linesChanged) for (const key of STRUCTURED_KEYS) if (input[key] === undefined) delete next[key];
    const pincode = String(next.pincode ?? "").trim();

    // The state must be a real Indian state / territory: Shopify needs its province code, and a typo would otherwise save an address without one. Checked for every order, linked or not.
    const provinceCode = provinceCodeFor(text(next.state));
    if (!provinceCode || !INDIAN_PROVINCE_CODES.has(provinceCode)) throw new ApiError(`"${text(next.state)}" is not a recognised Indian state or union territory. Choose the full state name (for example Maharashtra). Nothing was changed.`, STATUS_CODES.BAD_REQUEST);

    let shopify: EditResult["shopify"] = "not_linked";
    if (order.externalId) {
      const client = this.shopifyClient();
      await this.assertShopifyOpen(client, order.externalId);
      const forMapping: CrmOrderForShopify = {
        orderNumber: order.orderNumber, currency: order.currency, subtotal: order.subtotal.toString(), discountAmount: order.discountAmount.toString(), discountReason: null, shippingAmount: order.shippingAmount.toString(),
        taxAmount: order.taxAmount.toString(), totalAmount: order.totalAmount.toString(), shippingAddress: next, shippingPincode: pincode || order.shippingPincode, metadata: null, paymentMethod: null, paymentSucceeded: false, fromAiConversation: false,
        lead: { firstName: order.lead.firstName, lastName: order.lead.lastName, leadNumber: order.lead.leadNumber, email: order.lead.email, normalizedMobile: order.lead.normalizedMobile, mobile: order.lead.mobile },
        items: [],
      };
      const report: MappingReport = { fields: {} };
      const { shipping } = mapAddress(forMapping, report);
      if (!shipping) throw new ApiError("The address is incomplete, so it was not sent to Shopify. Nothing was changed.", STATUS_CODES.BAD_REQUEST);
      try {
        await updateOrderShippingAddress(client, order.externalId, shipping);
      } catch (error) {
        throw this.shopifyFailure(error, "update the delivery address");
      }
      shopify = "updated";
    }

    try {
      await this.db.order.update({ where: { id: order.id }, data: { shippingAddress: next as Prisma.InputJsonValue, shippingPincode: pincode || order.shippingPincode } });
      await this.audit(order.id, order.leadId, user, `Delivery address changed on ${order.externalNumber ?? order.orderNumber}`, before, { ...next, shopify });
    } catch (error) {
      logger.error(`Address change: Shopify ${shopify} but the CRM write failed for order ${order.orderNumber}`, error instanceof Error ? error.message : String(error));
      throw new ApiError("The address was changed in Shopify but saving it in the CRM failed. Repeat the change to bring the CRM in line.", 500);
    }
    return { shopify, address: next, message: shopify === "updated" ? "Delivery address updated in the CRM and in Shopify (the billing address is unchanged)." : "Delivery address updated in the CRM (the order is not linked to Shopify)." };
  }
}

export default OrderEditService;
