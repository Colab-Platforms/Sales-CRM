import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { CouponDiscountType, CustomerType } from "../../../generated/prisma/enums.js";

// CRM-managed coupons. Admin manages them (create / edit / switch on and off / delete); Create Order applies one by CODE and the backend
// decides everything: whether this customer may use it, and the amount. One coupon per order, never stacked (the order's discount is a
// single choice, see DiscountsService.resolve). A coupon an order has used is only ever soft-deleted, and the order keeps its own copy of
// code / type / amount, so history never depends on the coupon row.

export const CUSTOMER_TYPES = ["REGULAR", "DISTRIBUTOR"] as const;

export interface CouponRow {
  id: string;
  code: string;
  discountType: CouponDiscountType;
  discountValue: Prisma.Decimal;
  eligibleCustomerType: CustomerType | null;
  minOrderValue: Prisma.Decimal | null;
  maxDiscount: Prisma.Decimal | null;
  isActive: boolean;
  deletedAt: Date | null;
}

const bad = (m: string) => new ApiError(m, STATUS_CODES.BAD_REQUEST);
const cents = (d: { toString(): string } | null | undefined) => (d == null ? null : Math.round(Number(d.toString()) * 100));
export const normalizeCode = (code: string) => code.trim().toUpperCase();

export type CouponEvaluation = { ok: true; amountCents: number } | { ok: false; reason: string };

const TYPE_LABEL: Record<CustomerType, string> = { REGULAR: "regular customers", DISTRIBUTOR: "distributors" };

/** Pure. Whether a coupon may be used for a customer of `customerType` on `baseCents` (the items after line discounts), and the exact amount. */
export function evaluateCoupon(coupon: CouponRow, customerType: CustomerType, baseCents: number): CouponEvaluation {
  if (coupon.deletedAt) return { ok: false, reason: "This coupon is no longer available" };
  if (!coupon.isActive) return { ok: false, reason: "This coupon is not active" };
  if (coupon.eligibleCustomerType && coupon.eligibleCustomerType !== customerType) return { ok: false, reason: `Only for ${TYPE_LABEL[coupon.eligibleCustomerType]}; this customer is ${customerType === "DISTRIBUTOR" ? "a distributor" : "not a distributor"}` };
  const min = cents(coupon.minOrderValue);
  if (min !== null && baseCents < min) return { ok: false, reason: `Needs a minimum order of ₹${(min / 100).toFixed(2)}` };
  const value = cents(coupon.discountValue)!;
  let amount: number;
  if (coupon.discountType === "PERCENT") {
    amount = Math.round((baseCents * value) / 10_000);
    const max = cents(coupon.maxDiscount);
    if (max !== null) amount = Math.min(amount, max);
  } else {
    amount = value;
  }
  // A discount never exceeds what it applies to.
  if (amount > baseCents) return { ok: false, reason: "The discount is more than the order amount" };
  if (amount <= 0) return { ok: false, reason: "This coupon gives no discount on this amount" };
  return { ok: true, amountCents: amount };
}

export interface CouponInput {
  code: string;
  discountType: CouponDiscountType;
  discountValue: string;
  /** "ALL" or a customer type. */
  eligibility: "ALL" | CustomerType;
  minOrderValue?: string | null;
  maxDiscount?: string | null;
  isActive?: boolean;
}

const MONEY = /^\d+(\.\d{1,2})?$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{2,49}$/;

/** Pure. Throws the user-facing validation message, or returns the row data. */
export function validateCouponInput(input: CouponInput) {
  const code = normalizeCode(input.code);
  if (!CODE.test(code)) throw bad("Coupon code must be 3-50 characters: letters, numbers, - or _");
  if (input.discountType !== "FIXED" && input.discountType !== "PERCENT") throw bad("Discount type must be FIXED or PERCENT");
  const value = String(input.discountValue ?? "").trim();
  if (!MONEY.test(value) || Number(value) <= 0) throw bad("Enter a discount value greater than 0");
  if (input.discountType === "PERCENT" && Number(value) > 100) throw bad("A percentage discount cannot exceed 100%");
  if (input.eligibility !== "ALL" && !CUSTOMER_TYPES.includes(input.eligibility)) throw bad("Choose who can use this coupon");
  const optionalMoney = (raw: string | null | undefined, label: string) => {
    const t = raw == null ? "" : String(raw).trim();
    if (t === "") return null;
    if (!MONEY.test(t) || Number(t) <= 0) throw bad(`${label} must be an amount greater than 0`);
    return t;
  };
  const minOrderValue = optionalMoney(input.minOrderValue, "Minimum order value");
  const maxDiscount = optionalMoney(input.maxDiscount, "Maximum discount");
  if (maxDiscount !== null && input.discountType !== "PERCENT") throw bad("A maximum discount only applies to percentage coupons");
  return { code, discountType: input.discountType, discountValue: value, eligibleCustomerType: input.eligibility === "ALL" ? null : input.eligibility, minOrderValue, maxDiscount, isActive: input.isActive ?? true };
}

const SELECT = { id: true, code: true, discountType: true, discountValue: true, eligibleCustomerType: true, minOrderValue: true, maxDiscount: true, isActive: true, deletedAt: true, createdAt: true, updatedAt: true } satisfies Prisma.CouponSelect;

export const present = (c: Prisma.CouponGetPayload<{ select: typeof SELECT }>) => ({
  id: c.id,
  code: c.code,
  discountType: c.discountType,
  discountValue: c.discountValue.toString(),
  eligibility: (c.eligibleCustomerType ?? "ALL") as "ALL" | CustomerType,
  minOrderValue: c.minOrderValue?.toString() ?? null,
  maxDiscount: c.maxDiscount?.toString() ?? null,
  isActive: c.isActive,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

class CouponsService {
  constructor(private readonly db: DbClient = prisma) {}

  // ---------------------------------------------------------------- admin

  async list() {
    const rows = await this.db.coupon.findMany({ where: { deletedAt: null }, select: { ...SELECT, _count: { select: { orders: true } } }, orderBy: [{ createdAt: "asc" }, { code: "asc" }] });
    return rows.map((r) => ({ ...present(r), usedByOrders: r._count.orders }));
  }

  private async assertCodeFree(code: string, exceptId?: string) {
    const clash = await this.db.coupon.findFirst({ where: { code, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw new ApiError("A coupon with this code already exists", STATUS_CODES.CONFLICT);
  }

  async create(userId: string, input: CouponInput) {
    const data = validateCouponInput(input);
    await this.assertCodeFree(data.code);
    const row = await this.db.coupon.create({ data: { ...data, createdById: userId }, select: SELECT });
    return present(row);
  }

  private async live(id: string) {
    const row = await this.db.coupon.findFirst({ where: { id, deletedAt: null }, select: SELECT });
    if (!row) throw new ApiError("Coupon not found", STATUS_CODES.NOT_FOUND);
    return row;
  }

  async update(id: string, input: CouponInput) {
    await this.live(id);
    const data = validateCouponInput(input);
    await this.assertCodeFree(data.code, id);
    return present(await this.db.coupon.update({ where: { id }, data, select: SELECT }));
  }

  async setActive(id: string, isActive: boolean) {
    await this.live(id);
    return present(await this.db.coupon.update({ where: { id }, data: { isActive }, select: SELECT }));
  }

  /** Never used: removed outright. Used by an order: soft-deleted (and switched off), so the order's own record stays whole. */
  async remove(id: string): Promise<{ deleted: "hard" | "soft" }> {
    await this.live(id);
    const used = await this.db.order.count({ where: { couponId: id } });
    if (used === 0) {
      await this.db.coupon.delete({ where: { id } });
      return { deleted: "hard" };
    }
    await this.db.coupon.update({ where: { id }, data: { deletedAt: new Date(), isActive: false } });
    return { deleted: "soft" };
  }

  // ---------------------------------------------------------------- order creation

  /** The coupon a typed code names, or null (deleted coupons never match). Includes inactive ones so the caller can say why it is refused. */
  async findByCode(code: string): Promise<CouponRow | null> {
    return this.db.coupon.findFirst({ where: { code: normalizeCode(code), deletedAt: null }, select: SELECT });
  }

  /** What the telecaller sees in Edit Discount: every active coupon, with whether THIS customer can use it and why not. */
  async availableFor(customerType: CustomerType) {
    const rows = await this.db.coupon.findMany({ where: { isActive: true, deletedAt: null }, select: SELECT, orderBy: { code: "asc" } });
    return rows.map((c) => {
      // Who may use it is decided here; the order amount (minimum order, fixed value above the subtotal) is checked by the screen for the preview and again by the server when the order is created.
      const e = evaluateCoupon(c, customerType, Number.MAX_SAFE_INTEGER);
      const eligible = e.ok;
      return {
        code: c.code,
        id: c.id,
        type: c.discountType,
        value: c.discountValue.toString(),
        minOrderValue: c.minOrderValue?.toString() ?? null,
        maxDiscount: c.maxDiscount?.toString() ?? null,
        eligibility: (c.eligibleCustomerType ?? "ALL") as "ALL" | CustomerType,
        eligible,
        reason: e.ok ? null : e.reason,
      };
    });
  }

  async setCustomerType(leadId: string, customerType: CustomerType, scope: Prisma.LeadWhereInput) {
    if (!CUSTOMER_TYPES.includes(customerType)) throw bad("Customer type must be REGULAR or DISTRIBUTOR");
    const lead = await this.db.lead.findFirst({ where: { id: leadId, ...scope }, select: { id: true } });
    if (!lead) throw new ApiError("Customer not found", STATUS_CODES.NOT_FOUND);
    await this.db.lead.update({ where: { id: leadId }, data: { customerType } });
    return { leadId, customerType };
  }
}

export default CouponsService;
