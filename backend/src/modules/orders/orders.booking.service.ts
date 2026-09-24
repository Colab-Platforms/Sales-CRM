import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { getLeadScope } from "@/lib/leadScope.js";
import { Prisma } from "../../../generated/prisma/client.js";
import {
  ActivitySource,
  ActivityType,
  InterestedPeriodStatus,
  LeadWorkingStatus,
  OrderSource,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from "../../../generated/prisma/enums.js";
import { loadShiprocketConfig } from "../shiprocket/shiprocket.config.js";
import { sharedTokenProvider } from "../shiprocket/shiprocket.token.js";
import { resolveVariantForOrder, searchBookingCatalog, type ResolvedVariant } from "./orders.booking.shopify.js";
import type { CreateBookingBody, QuoteBody } from "./orders.booking.validators.js";

// E5 on-call booking service: lead lookup, catalog, serviceability, server-side pricing and order creation.

export type BookingServiceabilityStatus = "SERVICEABLE" | "NOT_SERVICEABLE" | "UNKNOWN";

export interface ServiceabilityResult {
  pincode: string;
  status: BookingServiceabilityStatus;
  reason: string | null;
  courierCount: number | null;
  checkedAt: string;
}

export interface QuoteLine extends ResolvedVariant {
  quantity: number;
  lineTotal: string;
}

export interface Quote {
  currency: "INR";
  lines: QuoteLine[];
  subtotal: string;
  discountPercent: number;
  discountAmount: string;
  total: string;
  maxDiscountPercent: number;
}

const PINCODE = /^[1-9][0-9]{5}$/;

// Money is calculated in integer paise so rounding can never drift.
function toPaise(price: string): number {
  const value = Number(price);
  if (!Number.isFinite(value) || value < 0) {
    throw new ApiError("The store returned an invalid price", 502);
  }
  return Math.round(value * 100);
}

const fromPaise = (paise: number) => (paise / 100).toFixed(2);

export function maxDiscountPercent(): number {
  const raw = Number(process.env.E5_MAX_DISCOUNT_PERCENT ?? "0");
  if (!Number.isFinite(raw)) return 0;
  return Math.min(Math.max(raw, 0), 100);
}

const BOOKING_ORDER_INCLUDE = {
  items: true,
  payments: true,
} satisfies Prisma.OrderInclude;

function generateOrderNumber(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `E5-${ymd}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

const isUniqueViolation = (error: unknown): error is { code: string; meta?: unknown } =>
  typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";

/**
 * US-5.8: CRM side of a successful conversion. Safe to call more than once for the same order.
 * Used at creation for COD, and (later) when Cashfree confirms a payment-link order.
 */
export async function markLeadConverted(
  tx: Prisma.TransactionClient,
  params: { leadId: string; orderId: string; orderNumber: string; actorId: string | null },
): Promise<void> {
  const now = new Date();
  await tx.lead.update({
    where: { id: params.leadId },
    data: { workingStatus: LeadWorkingStatus.CONVERTED, lastActivityAt: now },
  });
  await tx.interestedLeadPeriod.updateMany({
    where: { leadId: params.leadId, status: InterestedPeriodStatus.ACTIVE },
    data: { status: InterestedPeriodStatus.CONVERTED, endedAt: now },
  });
  await tx.activity.create({
    data: {
      leadId: params.leadId,
      orderId: params.orderId,
      actorId: params.actorId,
      type: ActivityType.ORDER_CONFIRMED,
      source: params.actorId ? ActivitySource.USER : ActivitySource.SYSTEM,
      referenceType: "Order",
      referenceId: params.orderId,
      title: `Order ${params.orderNumber} confirmed — lead converted`,
    },
  });
}

class OrderBookingService {
  /** US-5.1: find the caller's leads by mobile, only within what this user is allowed to see. */
  async lookupLeads(user: AuthUser, mobile: string) {
    const normalizedMobile = normalizeMobile(mobile);
    const last10 = mobile.replace(/\D/g, "").slice(-10);
    if (!normalizedMobile || last10.length !== 10) {
      throw new ApiError("Enter a valid mobile number", STATUS_CODES.BAD_REQUEST);
    }

    // Leads were saved by two different normalizers over time (with and without +91), so match every common form.
    const candidates = [...new Set([normalizedMobile, last10, `91${last10}`, `+91${last10}`, `0${last10}`])];
    const mobileMatch = {
      OR: [{ normalizedMobile: { in: candidates } }, { mobile: { in: candidates } }],
    };

    const scope = await getLeadScope(user);
    const leads = await prisma.lead.findMany({
      where: { AND: [scope, mobileMatch] },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        leadNumber: true,
        firstName: true,
        lastName: true,
        mobile: true,
        email: true,
        location: true,
        workingStatus: true,
        externalSource: true,
        source: { select: { name: true, type: true } },
      },
    });

    // Tell the salesperson the number exists elsewhere without revealing anything about that lead.
    const existsForAnotherOwner = leads.length === 0 && (await prisma.lead.count({ where: mobileMatch })) > 0;

    // US-5.2: the most recent shipping address, so a returning customer's address can be prefilled.
    const withLastAddress = await Promise.all(
      leads.map(async (lead) => {
        const lastOrder = await prisma.order.findFirst({
          where: { leadId: lead.id, shippingAddress: { not: undefined } },
          orderBy: { createdAt: "desc" },
          select: { shippingAddress: true, shippingPincode: true },
        });
        return {
          ...lead,
          registeredOnWebsite: lead.externalSource === "SHOPIFY",
          lastShippingAddress: lastOrder?.shippingAddress ?? null,
          lastShippingPincode: lastOrder?.shippingPincode ?? null,
        };
      }),
    );

    return { normalizedMobile, leads: withLastAddress, existsForAnotherOwner };
  }

  /** US-5.3: live product list from Shopify. */
  async catalog(search?: string) {
    return searchBookingCatalog(search);
  }

  /** US-5.4: can we deliver to this pincode? Any doubt is UNKNOWN, never SERVICEABLE. */
  async checkServiceability(pincode: string, cod: boolean): Promise<ServiceabilityResult> {
    const checkedAt = new Date().toISOString();
    const unknown = (reason: string): ServiceabilityResult => ({
      pincode,
      status: "UNKNOWN",
      reason,
      courierCount: null,
      checkedAt,
    });

    const pickup = process.env.SHIPROCKET_PICKUP_PINCODE?.trim();
    if (!pickup || !PINCODE.test(pickup)) return unknown("Pickup pincode is not configured");

    let config: ReturnType<typeof loadShiprocketConfig>;
    try {
      config = loadShiprocketConfig();
    } catch {
      return unknown("Shiprocket is not configured");
    }

    const weight = Number(process.env.SHIPROCKET_DEFAULT_WEIGHT_KG ?? "0.5") || 0.5;

    try {
      const token = await sharedTokenProvider(config).getToken();
      const url = new URL(`${config.baseUrl}/courier/serviceability/`);
      url.searchParams.set("pickup_postcode", pickup);
      url.searchParams.set("delivery_postcode", pincode);
      url.searchParams.set("weight", String(weight));
      url.searchParams.set("cod", cod ? "1" : "0");

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json().catch(() => null)) as
        | { status?: number; message?: string; data?: { available_courier_companies?: unknown[] } }
        | null;
      const couriers = json?.data?.available_courier_companies;

      if (res.ok && Array.isArray(couriers)) {
        return couriers.length > 0
          ? { pincode, status: "SERVICEABLE", reason: null, courierCount: couriers.length, checkedAt }
          : { pincode, status: "NOT_SERVICEABLE", reason: "No courier delivers here", courierCount: 0, checkedAt };
      }
      if (res.status === 404 || json?.status === 404) {
        return {
          pincode,
          status: "NOT_SERVICEABLE",
          reason: json?.message ?? "No courier delivers here",
          courierCount: 0,
          checkedAt,
        };
      }
      return unknown(`Shiprocket could not confirm (HTTP ${res.status})`);
    } catch {
      return unknown("Could not reach Shiprocket");
    }
  }

  /** US-5.5: authoritative price. Every price is re-read from Shopify; nothing from the browser is trusted. */
  async quote(body: QuoteBody): Promise<Quote> {
    const maxPercent = maxDiscountPercent();
    if (body.discountPercent > maxPercent) {
      throw new ApiError(`Discount cannot exceed ${maxPercent}%`, STATUS_CODES.BAD_REQUEST);
    }

    const resolved = await Promise.all(body.items.map((i) => resolveVariantForOrder(i.variantGid, i.quantity)));

    let subtotalPaise = 0;
    const lines: QuoteLine[] = resolved.map((variant, index) => {
      const quantity = body.items[index]!.quantity;
      const linePaise = toPaise(variant.unitPrice) * quantity;
      subtotalPaise += linePaise;
      return { ...variant, quantity, lineTotal: fromPaise(linePaise) };
    });

    const discountPaise = Math.round((subtotalPaise * body.discountPercent) / 100);
    const totalPaise = subtotalPaise - discountPaise;
    if (totalPaise <= 0) {
      throw new ApiError("Order total must be greater than zero", STATUS_CODES.BAD_REQUEST);
    }

    return {
      currency: "INR",
      lines,
      subtotal: fromPaise(subtotalPaise),
      discountPercent: body.discountPercent,
      discountAmount: fromPaise(discountPaise),
      total: fromPaise(totalPaise),
      maxDiscountPercent: maxPercent,
    };
  }

  /** US-5.7: place the reviewed order. Idempotent: the same idempotencyKey always returns the same order. */
  async createOrder(user: AuthUser, body: CreateBookingBody) {
    const findExisting = () =>
      prisma.order.findUnique({ where: { idempotencyKey: body.idempotencyKey }, include: BOOKING_ORDER_INCLUDE });

    const existing = await findExisting();
    if (existing) {
      if (existing.leadId !== body.leadId) {
        throw new ApiError("This request was already used for a different order", STATUS_CODES.CONFLICT);
      }
      return { order: existing, duplicate: true };
    }

    const scope = await getLeadScope(user);
    const lead = await prisma.lead.findFirst({
      where: { AND: [scope, { id: body.leadId }] },
      select: { id: true },
    });
    if (!lead) throw new ApiError("Lead not found", STATUS_CODES.NOT_FOUND);

    // Never trust the browser: price and stock are re-read from Shopify, delivery is re-checked.
    const quote = await this.quote({
      items: body.items,
      discountPercent: body.discountPercent,
      discountReason: body.discountReason,
    });

    const isCod = body.paymentMethod === "COD";
    const serviceability = await this.checkServiceability(body.address.pincode, isCod);
    if (serviceability.status === "NOT_SERVICEABLE") {
      throw new ApiError(`We cannot deliver to pincode ${body.address.pincode}`, STATUS_CODES.BAD_REQUEST);
    }

    const fullName = [body.customer.firstName, body.customer.lastName].filter(Boolean).join(" ");
    const shippingAddress = {
      name: fullName,
      firstName: body.customer.firstName,
      lastName: body.customer.lastName ?? null,
      phone: body.customer.mobile,
      email: body.customer.email ?? null,
      address1: body.address.line1,
      address2: body.address.line2 ?? null,
      city: body.address.city,
      province: body.address.state,
      zip: body.address.pincode,
      country: "India",
    };

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const order = await prisma.$transaction(
          async (tx) => {
            const now = new Date();
            const created = await tx.order.create({
              data: {
                orderNumber: generateOrderNumber(),
                leadId: lead.id,
                createdById: user.id,
                source: OrderSource.SALESPERSON,
                status: isCod ? OrderStatus.CONFIRMED : OrderStatus.PENDING_PAYMENT,
                currency: "INR",
                subtotal: quote.subtotal,
                discountAmount: quote.discountAmount,
                totalAmount: quote.total,
                discountReason: body.discountPercent > 0 ? (body.discountReason ?? null) : null,
                idempotencyKey: body.idempotencyKey,
                serviceabilityStatus: serviceability.status,
                serviceabilityCheckedAt: new Date(serviceability.checkedAt),
                shippingAddress,
                shippingPincode: body.address.pincode,
                metadata: {
                  e5: {
                    channel: "ON_CALL",
                    paymentMethod: body.paymentMethod,
                    discountPercent: body.discountPercent,
                    serviceability: { status: serviceability.status, reason: serviceability.reason },
                    items: quote.lines.map((l) => ({
                      productGid: l.productGid,
                      variantGid: l.variantGid,
                      quantity: l.quantity,
                    })),
                  },
                },
                placedAt: now,
                confirmedAt: isCod ? now : null,
                items: {
                  create: quote.lines.map((l) => ({
                    productNameSnapshot: l.productTitle,
                    variantNameSnapshot: l.variantTitle,
                    skuSnapshot: l.sku,
                    quantity: l.quantity,
                    unitPrice: l.unitPrice,
                    totalPrice: l.lineTotal,
                  })),
                },
              },
            });

            if (isCod) {
              // COD money arrives on delivery, so the payment stays PENDING — never SUCCESS here.
              await tx.payment.create({
                data: {
                  orderId: created.id,
                  provider: "COD",
                  method: PaymentMethod.COD,
                  status: PaymentStatus.PENDING,
                  amount: quote.total,
                  currency: "INR",
                },
              });
            }

            await tx.activity.create({
              data: {
                leadId: lead.id,
                orderId: created.id,
                actorId: user.id,
                type: ActivityType.ORDER_CREATED,
                source: ActivitySource.USER,
                referenceType: "Order",
                referenceId: created.id,
                title: `Order ${created.orderNumber} placed on call`,
                description: `${quote.lines.length} item(s), total ₹${quote.total}, ${body.paymentMethod}`,
              },
            });

            if (isCod) {
              await markLeadConverted(tx, {
                leadId: lead.id,
                orderId: created.id,
                orderNumber: created.orderNumber,
                actorId: user.id,
              });
            }

            return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: BOOKING_ORDER_INCLUDE });
          },
          { timeout: 20_000, maxWait: 10_000 },
        );
        return { order, duplicate: false };
      } catch (error) {
        if (isUniqueViolation(error)) {
          // A parallel request with the same key won the race: return its order instead of a duplicate.
          if (JSON.stringify(error.meta ?? {}).includes("idempotency")) {
            const winner = await findExisting();
            if (winner) return { order: winner, duplicate: true };
          }
          // Otherwise it was an order-number collision: retry with a new number.
          if (attempt < 4) continue;
        }
        throw error;
      }
    }
    throw new ApiError("Could not generate a unique order number", STATUS_CODES.SERVER_ERROR);
  }
}

export default OrderBookingService;