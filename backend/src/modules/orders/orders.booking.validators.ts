import { z } from "zod";
import { validateSchema } from "@/utils/validate.js";

// E5 on-call booking: request validation. The server re-checks everything; the UI's checks are only for convenience.

const pincode = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Pincode must be a valid 6-digit Indian pincode");

const variantGid = z
  .string()
  .regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/, "Invalid product variant");

const bookingItemSchema = z.object({
  variantGid,
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .min(1, "Quantity must be at least 1")
    .max(100, "Quantity is too large"),
});

const itemsSchema = z
  .array(bookingItemSchema)
  .min(1, "Add at least one product")
  .max(20, "Too many products in one order")
  .refine((items) => new Set(items.map((i) => i.variantGid)).size === items.length, {
    message: "Each variant can appear only once; change its quantity instead",
  });

const discountFields = {
  discountPercent: z.number().min(0, "Discount cannot be negative").max(100).default(0),
  discountReason: z.string().trim().max(500).optional(),
};

const requireReasonForDiscount = (
  data: { discountPercent: number; discountReason?: string },
  ctx: z.RefinementCtx,
) => {
  if (data.discountPercent > 0 && !data.discountReason) {
    ctx.addIssue({ code: "custom", path: ["discountReason"], message: "A reason is required when giving a discount" });
  }
};

const lookupQuerySchema = z.object({
  mobile: z.string().trim().min(10, "Enter a valid mobile number").max(20),
});

const catalogQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
});

const serviceabilityQuerySchema = z.object({
  pincode,
  cod: z.enum(["true", "false"]).optional(),
});

const quoteBodySchema = z.object({ items: itemsSchema, ...discountFields }).superRefine(requireReasonForDiscount);

const createBookingSchema = z
  .object({
    leadId: z.uuid("Invalid lead"),
    // Generated once by the order screen and resent on every retry, so a retry can never create a second order.
    idempotencyKey: z.string().trim().min(16).max(100),
    customer: z.object({
      firstName: z.string().trim().min(1, "First name is required").max(100),
      lastName: z.string().trim().max(100).optional(),
      mobile: z.string().trim().min(10, "Enter a valid mobile number").max(20),
      email: z.email("Enter a valid email").max(255).optional(),
    }),
    address: z.object({
      line1: z.string().trim().min(1, "Address is required").max(255),
      line2: z.string().trim().max(255).optional(),
      city: z.string().trim().min(1, "City is required").max(100),
      state: z.string().trim().min(1, "State is required").max(100),
      pincode,
    }),
    items: itemsSchema,
    ...discountFields,
    paymentMethod: z.enum(["PAYMENT_LINK", "COD"]),
    // US-5.7: the salesperson must explicitly confirm the reviewed order.
    confirmed: z.literal(true, { message: "Please review and confirm the order" }),
  })
  .superRefine(requireReasonForDiscount);

export type BookingItemInput = z.infer<typeof bookingItemSchema>;
export type LookupQuery = z.infer<typeof lookupQuerySchema>;
export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
export type ServiceabilityQuery = z.infer<typeof serviceabilityQuerySchema>;
export type QuoteBody = z.infer<typeof quoteBodySchema>;
export type CreateBookingBody = z.infer<typeof createBookingSchema>;

export const validateLookupQuery = (q: unknown) => validateSchema<LookupQuery>(lookupQuerySchema, q);
export const validateCatalogQuery = (q: unknown) => validateSchema<CatalogQuery>(catalogQuerySchema, q);
export const validateServiceabilityQuery = (q: unknown) =>
  validateSchema<ServiceabilityQuery>(serviceabilityQuerySchema, q);
export const validateQuoteBody = (b: unknown) => validateSchema<QuoteBody>(quoteBodySchema, b);
export const validateCreateBookingBody = (b: unknown) => validateSchema<CreateBookingBody>(createBookingSchema, b);