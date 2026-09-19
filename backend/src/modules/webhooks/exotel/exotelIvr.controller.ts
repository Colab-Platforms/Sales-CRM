import { Request, Response, NextFunction } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { processExotelIvrWebhook } from "./exotelIvr.service.js";

// TODO(exotel-security): no Exotel webhook authentication/signature verification
// exists yet. The exact mechanism available for this account/flow has not been
// confirmed. Do not treat this endpoint as production-secure until that is added.
//
// Handles both the primary GET (Exotel Passthru sends URL-encoded query
// params) and the dev/test POST path — see exotelIvr.routes.ts.
export async function handleExotelIvrWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const source: unknown = req.method === "GET" ? req.query : req.body;
    const payload: Record<string, unknown> =
      source && typeof source === "object" && !Array.isArray(source) ? (source as Record<string, unknown>) : {};

    const result = await processExotelIvrWebhook(payload);

    sendResponse(
      res,
      true,
      result,
      result.duplicate ? "Duplicate webhook event ignored" : "Webhook event received",
      STATUS_CODES.OK,
    );
  } catch (err) {
    next(err);
  }
}
