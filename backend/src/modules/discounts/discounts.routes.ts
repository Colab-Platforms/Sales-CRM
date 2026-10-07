import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, type AuthRequest } from "@/middlewares/auth.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role } from "../../../generated/prisma/enums.js";
import DiscountsService from "./discounts.service.js";

const service = new DiscountsService();
const router = Router();
const run = (fn: (req: AuthRequest) => Promise<unknown>) => async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await fn(req), "ok", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
const bad = (m: string) => Object.assign(new Error(m), { statusCode: STATUS_CODES.BAD_REQUEST });

// Everyone who can create orders / offer a prepaid upgrade can read what they pick from: the configured default discount and the
// live Fastrr coupons. The CRM has no coupon list of its own to manage.
router.get("/options", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), run(async (req) => {
  const flow = z.enum(["ORDER", "UPGRADE"]).safeParse(req.query.flow);
  if (!flow.success) throw bad("flow must be ORDER or UPGRADE");
  return service.options(flow.data);
}));

export default router;
