import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthRequest } from "@/middlewares/auth.js";
import { getLeadScope } from "@/lib/leadScope.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role } from "../../../generated/prisma/enums.js";
import CouponsService, { CUSTOMER_TYPES } from "./coupons.service.js";

const service = new CouponsService();
const router = Router();
const run = (fn: (req: AuthRequest) => Promise<unknown>, okStatus: number = STATUS_CODES.OK) => async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await fn(req), "ok", okStatus);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
const bad = (m: string) => Object.assign(new Error(m), { statusCode: STATUS_CODES.BAD_REQUEST });
const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success) throw bad(r.error.issues[0]?.message ?? "Invalid request");
  return r.data;
};

const money = z.union([z.string(), z.number()]).transform((v) => String(v));
const couponBody = z
  .object({
    code: z.string({ error: "Enter a coupon code" }),
    discountType: z.enum(["FIXED", "PERCENT"], { error: "Discount type must be FIXED or PERCENT" }),
    discountValue: money,
    eligibility: z.enum(["ALL", ...CUSTOMER_TYPES], { error: "Choose who can use this coupon" }),
    minOrderValue: money.nullable().optional(),
    maxDiscount: money.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();
const idParam = z.object({ id: z.uuid({ error: "Invalid coupon id" }) });

// Coupons are an Admin-only area. The values themselves are re-validated on the server for every order (DiscountsService.resolve).
router.get("/", requireAuth, requireRole(Role.ADMIN), run(() => service.list()));
router.post("/", requireAuth, requireRole(Role.ADMIN), run((req) => service.create(req.user!.id, parse(couponBody, req.body)), STATUS_CODES.CREATED));

// Marking a customer as a distributor (what DISTRIBUTOR500 checks). Admin, or a Manager for a customer in their scope.
router.patch("/customer-type/:leadId", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), run(async (req) => {
  const { leadId } = parse(z.object({ leadId: z.uuid({ error: "Invalid customer id" }) }), req.params);
  const { customerType } = parse(z.object({ customerType: z.enum(CUSTOMER_TYPES, { error: "Customer type must be REGULAR or DISTRIBUTOR" }) }).strict(), req.body);
  return service.setCustomerType(leadId, customerType, await getLeadScope(req.user!));
}));

router.put("/:id", requireAuth, requireRole(Role.ADMIN), run((req) => service.update(parse(idParam, req.params).id, parse(couponBody, req.body))));
router.patch("/:id/active", requireAuth, requireRole(Role.ADMIN), run((req) => service.setActive(parse(idParam, req.params).id, parse(z.object({ isActive: z.boolean({ error: "isActive must be true or false" }) }).strict(), req.body).isActive)));
router.delete("/:id", requireAuth, requireRole(Role.ADMIN), run((req) => service.remove(parse(idParam, req.params).id)));

export default router;
