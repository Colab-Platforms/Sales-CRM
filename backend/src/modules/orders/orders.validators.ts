import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";
import { OrderSource, OrderStatus, PaymentMethod, PaymentStatus } from "../../../generated/prisma/enums.js";
import { NO_PAYMENT, type CancelOrderInput, type CreateManualOrderInput, type ListOrdersQuery } from "./orders.types.js";

// The frontend omits empty filters, but treat `?status=` as "not set" too.
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());

const listOrdersQuerySchema = z
  .object({
    page: z.coerce.number({ error: "page must be a number" }).int().min(1, "page must be 1 or more").default(1),
    pageSize: z.coerce
      .number({ error: "pageSize must be a number" })
      .int()
      .min(1, "pageSize must be between 1 and 100")
      .max(100, "pageSize must be between 1 and 100")
      .default(20),
    search: optional(z.string().trim().max(100, "search must be 100 characters or fewer")),
    status: optional(z.enum(OrderStatus, { error: "Invalid order status" })),
    paymentStatus: optional(z.enum([...Object.values(PaymentStatus), NO_PAYMENT], { error: "Invalid payment status" })),
    source: optional(z.enum(OrderSource, { error: "Invalid order source" })),
    salespersonId: optional(z.uuid({ error: "Invalid salesperson id" })),
    dateFrom: optional(z.iso.datetime({ offset: true, error: "dateFrom must be an ISO date-time" }).transform((v) => new Date(v))),
    dateTo: optional(z.iso.datetime({ offset: true, error: "dateTo must be an ISO date-time" }).transform((v) => new Date(v))),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    error: "dateFrom must not be after dateTo",
  });

const orderIdParamsSchema = z.object({
  id: z.uuid({ error: "Invalid order id" }),
});

// Decimal columns are stored/sent as strings (see orders.types.ts's own Money comment) - this is the
// one shape check every money field in a manual order shares.
const money = (field: string) => z.string().regex(/^\d+(\.\d{1,2})?$/, `${field} must be a non-negative decimal amount`);

// An order line is either a CATALOGUE item (a product, optionally a variant - exactly as before; itemType may be omitted) or a CUSTOM item (a free-form line with a name and a price and NO product / variant).
// Nothing monetary is trusted from the browser: the server recomputes every line, subtotal and total. A custom item's weight is optional, only for physical items, and is normalised to grams by the service.
export const CUSTOM_ITEM_MAX_QUANTITY = 999;
const createManualOrderItemSchema = z
  .object({
    itemType: z.enum(["CATALOG", "CUSTOM"], { error: "itemType must be CATALOG or CUSTOM" }).optional(),
    productId: z.uuid({ error: "Invalid product id" }).optional(),
    variantId: z.uuid({ error: "Invalid variant id" }).optional(),
    customName: z.string({ error: "Item name is required" }).trim().min(1, "Item name is required").max(200, "Item name must be 200 characters or fewer").optional(),
    quantity: z.coerce.number({ error: "quantity must be a number" }).int().min(1, "quantity must be at least 1"),
    unitPrice: money("unitPrice"),
    discountAmount: optional(money("discountAmount")),
    taxable: z.boolean({ error: "taxable must be true or false" }).optional(),
    requiresShipping: z.boolean({ error: "requiresShipping must be true or false" }).optional(),
    weight: z.string().trim().regex(/^\d+(\.\d{1,3})?$/, "Weight must be a positive number with up to 3 decimals").optional(),
    weightUnit: z.enum(["KG", "G"], { error: "Weight unit must be KG or G" }).optional(),
  })
  .superRefine((item, ctx) => {
    const type = item.itemType ?? "CATALOG";
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (type === "CATALOG") {
      if (!item.productId) issue("productId", "Invalid product id");
      for (const field of ["customName", "taxable", "requiresShipping", "weight", "weightUnit"] as const) if (item[field] !== undefined) issue(field, "Only a custom item can have this field");
      return;
    }
    if (item.productId || item.variantId) issue("productId", "A custom item has no product or variant");
    if (!item.customName) issue("customName", "Item name is required");
    if (item.quantity > CUSTOM_ITEM_MAX_QUANTITY) issue("quantity", `Quantity must be ${CUSTOM_ITEM_MAX_QUANTITY} or fewer`);
    if (item.weight !== undefined || item.weightUnit !== undefined) {
      if (item.weight === undefined || item.weightUnit === undefined) issue("weight", "Give both the weight and its unit");
      else if (item.requiresShipping === false) issue("weight", "Only a physical item has a weight");
      else if (!(Number(item.weight) > 0)) issue("weight", "Weight must be greater than 0");
      else if ((item.weightUnit === "KG" ? Number(item.weight) * 1000 : Number(item.weight)) > 1_000_000) issue("weight", "Weight is too large");
    }
  });

// Structured delivery address. line1/line2 stay the composed lines every downstream integration (Shopify, Shiprocket) already
// reads; the structured fields (houseNumber, building, area, street, landmark, addressType) are stored alongside them.
// Older callers that send only line1/line2 keep working - the extra fields are optional - but whatever is sent must be
// complete: a delivery address with no pincode/city/state/line1 is rejected, and a structured one also needs its area.
const hasContent = (v: string | undefined) => v !== undefined && /[\p{L}\p{N}]/u.test(v); // not blank, not just punctuation
const shippingAddressSchema = z
  .object({
    name: optional(z.string().trim().max(200)),
    line1: optional(z.string().trim().max(255)),
    line2: optional(z.string().trim().max(255)),
    city: optional(z.string().trim().max(100)),
    state: optional(z.string().trim().max(100)),
    pincode: optional(z.string().trim().regex(/^[1-9]\d{5}$/, "Pincode must be a valid 6-digit Indian pincode")),
    phone: optional(z.string().trim().max(20)),
    houseNumber: optional(z.string().trim().max(120)),
    building: optional(z.string().trim().max(160)),
    area: optional(z.string().trim().max(160)),
    street: optional(z.string().trim().max(160)),
    landmark: optional(z.string().trim().max(160)),
    // What the customer asked for at delivery ("leave with the guard") - kept with the address instead of being dropped.
    deliveryInstructions: optional(z.string().trim().max(255)),
    addressType: optional(z.enum(["HOME", "WORK", "OTHER"], { error: "Address type must be HOME, WORK or OTHER" })),
  })
  .superRefine((a, ctx) => {
    const need = (field: "line1" | "city" | "state" | "pincode" | "houseNumber" | "area", message: string) => {
      if (!hasContent(a[field])) ctx.addIssue({ code: "custom", path: [field], message });
    };
    need("line1", "House / Flat / Building No. is required");
    need("city", "City is required");
    need("state", "State is required");
    if (!a.pincode) ctx.addIssue({ code: "custom", path: ["pincode"], message: "Pincode is required" });
    if (a.houseNumber !== undefined || a.area !== undefined) {
      need("houseNumber", "House / Flat / Building No. is required");
      need("area", "Area / Locality is required");
    }
  });

const createManualOrderSchema = z.object({
  leadId: z.uuid({ error: "Invalid customer id" }),
  abandonmentId: optional(z.uuid({ error: "Invalid abandoned checkout id" })),
  items: z.array(createManualOrderItemSchema).min(1, "At least one item is required").max(50, "Too many items"),
  paymentMethod: z.enum(PaymentMethod, { error: "Invalid payment method" }),
  shippingAddress: optional(shippingAddressSchema),
  shippingPincode: optional(z.string().trim().regex(/^[1-9]\d{5}$/, "Pincode must be a valid 6-digit Indian pincode")),
  shippingAmount: optional(money("shippingAmount")),
  discountAmount: optional(money("discountAmount")),
  // Custom Discount: a percentage, validated and applied only by computePercentDiscount() in the service (a string, so
  // "-1", "abc" or "101" reach it intact and get its specific messages instead of a generic type error).
  discountPercent: optional(z.union([z.string(), z.number()]).transform((v) => String(v))),
  // Create Order discount selection: a Fastrr coupon code, a custom type + value, or none. REPLACES any default (never stacks).
  // No amount or total is accepted from the browser - the server resolves and recomputes everything. `expectedTotal` is only a
  // consistency check: if what the user saw differs from what the server computes, the order is refused, not created.
  discount: optional(
    z
      .object({
        none: z.boolean().optional(),
        couponCode: z.string().trim().min(1).max(100).optional(),
        type: z.enum(["FIXED", "PERCENT"], { error: "Discount type must be FIXED or PERCENT" }).optional(),
        value: z.union([z.string(), z.number()]).transform((v) => String(v)).optional(),
      })
      .strict(),
  ),
  expectedTotal: optional(money("expectedTotal")),
  // The packed parcel weight (kg) entered by the telecaller - optional here, never defaulted. Must be a real positive number when given.
  parcelWeightKg: optional(z.coerce.number({ error: "Parcel weight must be a number" }).gt(0, "Parcel weight must be greater than 0").max(100, "Parcel weight must be 100 kg or less")),
  // Send the Cashfree payment link on WhatsApp with a chosen approved Meta template. undefined = the order's original behaviour
  // (unchanged); false = "Don't send"; true = send (needs a valid number, consent and an approved payment template).
  sendPaymentLinkViaWhatsApp: z.boolean({ error: "sendPaymentLinkViaWhatsApp must be true or false" }).optional(),
  whatsappTemplateId: optional(z.uuid({ error: "Invalid WhatsApp template id" })),
  whatsappConsent: z.boolean({ error: "whatsappConsent must be true or false" }).optional(),
  discountReason: optional(z.string().trim().max(255)),
  idempotencyKey: optional(z.string().trim().min(8).max(100)),
  acknowledgeDuplicate: optional(z.boolean()),
  // Prepaid only: the customer already paid OUTSIDE Cashfree (a personal / company UPI QR, ...). The order is created as paid, with no payment link or QR. Default false.
  paymentAlreadyReceived: z.boolean({ error: "paymentAlreadyReceived must be true or false" }).optional(),
  // Optional UTR / transaction reference of that external payment.
  paymentReference: optional(z.string().trim().max(100)),
  supersedesOrderId: optional(z.uuid({ error: "Invalid order id" })),
});

export const validateCreateManualOrder = (body: unknown) => validateSchema<CreateManualOrderInput>(createManualOrderSchema, body);

export const validateListOrdersQuery = (query: unknown) =>
  validateSchema<ListOrdersQuery>(listOrdersQuerySchema, query);

export const validateOrderIdParams = (params: unknown) =>
  validateSchema<{ id: string }>(orderIdParamsSchema, params);

const cancelOrderSchema = z.object({
  reason: optional(z.string().trim().max(500, "reason must be 500 characters or fewer")),
});

export const validateCancelOrder = (body: unknown) => validateSchema<CancelOrderInput>(cancelOrderSchema, body);

// ---- Editing an existing order: change a line's flavour / the delivery address ----
const itemParamsSchema = z.object({ id: z.uuid({ error: "Invalid order id" }), itemId: z.uuid({ error: "Invalid order item id" }) });
export const validateOrderItemParams = (params: unknown) => validateSchema<{ id: string; itemId: string }>(itemParamsSchema, params);
const changeFlavourSchema = z.object({ variantId: z.uuid({ error: "Invalid flavour (variant) id" }) });
export const validateChangeFlavour = (body: unknown) => validateSchema<{ variantId: string }>(changeFlavourSchema, body);
export const validateUpdateShippingAddress = (body: unknown) => validateSchema<Record<string, string | undefined>>(shippingAddressSchema, body);

// ---- Sync / Update from CRM ----
const syncApplySchema = z.object({
  stateToken: z.string().trim().min(8, "stateToken is required").max(64),
  actions: z.array(z.enum(["customer.link", "customer.name", "shipping.address", "tags.add"], { error: "Unknown sync action" })).min(1, "Choose at least one change to sync").max(4),
  confirm: z.boolean({ error: "Explicit confirmation is required" }),
});
export const validateSyncApply = (body: unknown) => validateSchema<{ stateToken: string; actions: ("customer.link" | "customer.name" | "shipping.address" | "tags.add")[]; confirm: boolean }>(syncApplySchema, body);

// ---- Review & Correct Amount ----
const amountCorrectionSchema = z.object({
  stateToken: z.string().trim().min(8, "stateToken is required").max(64),
  confirmTotal: z.string().trim().regex(/^\d+(\.\d{2})?$/, "Type the corrected total exactly as shown (for example 699.00)"),
  confirm: z.boolean({ error: "Explicit confirmation is required" }),
});
export const validateAmountCorrection = (body: unknown) => validateSchema<{ stateToken: string; confirmTotal: string; confirm: boolean }>(amountCorrectionSchema, body);
