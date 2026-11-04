import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { prisma } from "@/lib/prisma.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { readShopifySyncSetting, writeShopifySyncSetting, type ShopifySyncSetting } from "../settings/shopify-sync.setting.js";

/** Pure: the body must be exactly { enabled: boolean }. */
export function parseShopifySyncBody(body: unknown): { enabled: boolean } | null {
  if (!body || typeof body !== "object") return null;
  const enabled = (body as { enabled?: unknown }).enabled;
  return typeof enabled === "boolean" ? { enabled } : null;
}

export const getShopifyCrmOrderSync = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await readShopifySyncSetting(prisma as never), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const setShopifyCrmOrderSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const body = parseShopifySyncBody(req.body);
    if (!body) {
      sendResponse(res, false, null, "enabled must be true or false", STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result: ShopifySyncSetting = await writeShopifySyncSetting(prisma as never, body.enabled, req.user!.id);
    logger.info(`Shopify sync for CRM-created orders turned ${body.enabled ? "ON" : "OFF"} by user ${req.user!.id}`);
    sendResponse(res, true, result, `Shopify sync for CRM-created orders is now ${body.enabled ? "ON" : "OFF"}.`, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
