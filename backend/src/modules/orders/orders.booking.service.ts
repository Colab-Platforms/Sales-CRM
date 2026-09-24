import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { normalizeMobile } from "@/lib/leadIdentity.js";
import { getLeadScope } from "@/lib/leadScope.js";
import { loadShiprocketConfig } from "../shiprocket/shiprocket.config.js";
import { sharedTokenProvider } from "../shiprocket/shiprocket.token.js";
import { resolveVariantForOrder, searchBookingCatalog, type ResolvedVariant } from "./orders.booking.shopify.js";
import type { QuoteBody } from "./orders.booking.validators.js";

// E5 on-call booking service: lead lookup, catalog, serviceability and server-side pricing.

export type ServiceabilityStatus = "SERVICEABLE" | "NOT_SERVICEABLE" | "UNKNOWN";

export interface ServiceabilityResult {
  pincode: string;
  status: ServiceabilityStatus;
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
    const existsForAnotherOwner =
      leads.length === 0 && (await prisma.lead.count({ where: mobileMatch })) > 0;
      
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
      const url = new URL(`${config.baseUrl}/courier/serviceability/`);      url.searchParams.set("pickup_postcode", pickup);
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
}

export default OrderBookingService;