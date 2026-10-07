import { Response } from "express";
import { z } from "zod";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import PrepaidUpgradeService from "./orders.prepaid-upgrade.service.js";

const service = new PrepaidUpgradeService();

const liveIds = z.object({ externalId: z.string().regex(/^\d{5,25}$/, "Invalid Shopify order id") });
const ids = z.object({ id: z.uuid({ error: "Invalid order id" }), upgradeId: z.uuid({ error: "Invalid offer id" }).optional() });
// The browser sends ONLY the discount type and the value the telecaller typed. Any amount it might add is ignored (stripped
// by the schema) - the server computes the discount and the prepaid amount itself.
const createBody = z.object({
  // Either a Fastrr coupon code (its own type/value apply) or a custom type + value. Never an amount to charge.
  couponCode: z.string().trim().min(1).max(100).optional(),
  discountType: z.enum(["FIXED", "PERCENT"], { error: "Discount type must be FIXED or PERCENT" }).optional(),
  discountValue: z.union([z.string(), z.number()], { error: "Enter a valid discount" }).transform((v) => String(v)).optional(),
  /** What the user saw as the amount to collect: a consistency check only - refused if the server computes something else. */
  expectedPrepaidAmount: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
});

const run = (handler: (req: AuthRequest) => Promise<unknown>, message: string) => async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await handler(req), message, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
const parseIds = (params: unknown) => {
  const r = ids.safeParse(params);
  if (!r.success) throw Object.assign(new Error(r.error.issues[0]?.message ?? "Invalid id"), { statusCode: STATUS_CODES.BAD_REQUEST });
  return r.data;
};

export const getPrepaidUpgrade = run((req) => service.getUpgrade(req.user!, parseIds(req.params).id), "Prepaid upgrade");

export const createPrepaidUpgrade = run(async (req) => {
  const { id } = parseIds(req.params);
  const body = createBody.safeParse(req.body ?? {});
  if (!body.success) throw Object.assign(new Error(body.error.issues[0]?.message ?? "Invalid discount"), { statusCode: STATUS_CODES.BAD_REQUEST });
  return service.createOffer(req.user!, id, body.data);
}, "Prepaid upgrade offered");

export const generatePrepaidUpgradeLink = run((req) => {
  const { id, upgradeId } = parseIds(req.params);
  return service.generateLink(req.user!, id, upgradeId ?? "");
}, "Prepaid upgrade payment link");

export const declinePrepaidUpgrade = run((req) => {
  const { id, upgradeId } = parseIds(req.params);
  return service.decline(req.user!, id, upgradeId ?? "");
}, "Prepaid upgrade declined");

// Shopify orders addressed by their Shopify id (the Order Detail page of an order the CRM has not synced). If the order is
// already in the CRM these resolve to it; otherwise ADMIN only, and the first offer brings it in (see the service).
const parseLive = (params: unknown) => {
  const r = liveIds.safeParse(params);
  if (!r.success) throw Object.assign(new Error(r.error.issues[0]?.message ?? "Invalid id"), { statusCode: STATUS_CODES.BAD_REQUEST });
  return r.data.externalId;
};
export const getLivePrepaidUpgrade = run((req) => service.getLiveUpgrade(req.user!, parseLive(req.params)), "Prepaid upgrade");
export const createLivePrepaidUpgrade = run(async (req) => {
  const externalId = parseLive(req.params);
  const body = createBody.safeParse(req.body ?? {});
  if (!body.success) throw Object.assign(new Error(body.error.issues[0]?.message ?? "Invalid discount"), { statusCode: STATUS_CODES.BAD_REQUEST });
  return service.createLiveOffer(req.user!, externalId, body.data);
}, "Prepaid upgrade offered");
