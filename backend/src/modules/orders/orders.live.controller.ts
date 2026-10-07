import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import OrdersLiveService from "./orders.live.service.js";
import { validateLiveOrderHistoryQuery, validateLiveOrdersQuery } from "./orders.live.validators.js";

const ordersLiveService = new OrdersLiveService();

// Never fails the request just because Shopify is down/slow - OrdersLiveService already reports that
// as result.error, so the frontend gets a clean 200 with an actionable message instead of a 5xx.
export const listLiveOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateLiveOrdersQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await ordersLiveService.listLiveOrders(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Cancels a Shopify order the CRM has not synced yet - the only destructive action Shopify actually
// supports (no delete). ADMIN-only, same visibility as the detail page itself.
// Options for the Orders Tags filter (Shopify's tags + the CRM confirmation tags). Never fails the page: a Shopify problem comes back as `error`.
export const getLiveTagOptions = async (_req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await ordersLiveService.listTagOptions(), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const cancelLiveOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const externalId = String(req.params.externalId ?? "");
    if (!/^\d+$/.test(externalId)) {
      sendResponse(res, false, null, "Order not found", STATUS_CODES.NOT_FOUND);
      return;
    }

    const result = await ordersLiveService.cancelLiveOrder(req.user!, externalId);
    if (!result.cancelled) {
      const notFound = result.reason === "Not found";
      sendResponse(res, false, null, result.reason ?? "Could not cancel the order", notFound ? STATUS_CODES.NOT_FOUND : STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// "Previous Orders" on the live Order Detail page - the Shopify customer's other orders, cursor-
// paginated. Same ADMIN-only visibility as the detail page it's called from.
export const getLiveOrderHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const shopifyCustomerId = String(req.params.customerId ?? "");
    const excludeExternalId = typeof req.query.excludeExternalId === "string" ? req.query.excludeExternalId : "";
    if (!/^\d+$/.test(shopifyCustomerId)) {
      sendResponse(res, false, null, "Customer not found", STATUS_CODES.NOT_FOUND);
      return;
    }

    const { error, value } = validateLiveOrderHistoryQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await ordersLiveService.getLiveOrderHistory(req.user!, shopifyCustomerId, excludeExternalId, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Order Detail for a Shopify order not yet synced into the CRM (see orderDetailHref's "shopify:"
// prefix in the frontend). Not found / not ADMIN both come back as a plain 404 (never distinguishing
// "exists but you can't see it" from "doesn't exist" - same probing protection scopedOrderWhere uses).
export const getLiveOrderDetail = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const externalId = String(req.params.externalId ?? "");
    if (!/^\d+$/.test(externalId)) {
      sendResponse(res, false, null, "Order not found", STATUS_CODES.NOT_FOUND);
      return;
    }

    const result = await ordersLiveService.getLiveOrderDetail(req.user!, externalId);
    if (!result.order) {
      sendResponse(res, false, null, result.error ?? "Order not found", STATUS_CODES.NOT_FOUND);
      return;
    }
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
