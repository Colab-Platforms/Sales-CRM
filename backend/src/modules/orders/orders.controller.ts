import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import OrdersService from "./orders.service.js";
import { validateCancelOrder, validateCreateManualOrder, validateListOrdersQuery, validateOrderIdParams } from "./orders.validators.js";

const ordersService = new OrdersService();

export const listOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListOrdersQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await ordersService.listOrders(req.user!, value);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await ordersService.getOrder(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrderStatusHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    const result = await ordersService.getStatusHistory(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// E7.8 (WhatsApp -> CRM Order): the CRM's manual order-entry endpoint. RBAC is entirely server-side
// (getLeadScope/scopedLeadWhere inside the service) - a TELECALLER can only create an order for a
// lead already in their own scope, the same rule every other single-lead endpoint already enforces.
export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateCreateManualOrder(req.body);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await ordersService.createManualOrder(req.user!, value);
    sendResponse(res, true, result, "Order created", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Retries just the Shopify half after a "created" order's push failed - never re-creates the CRM
// order, and (see pushOrderToShopify) never creates a second Shopify order for one already linked.
export const pushOrderToShopify = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await ordersService.pushOrderToShopify(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Manual retry of Shopify payment reconciliation. RBAC is server-side (getLeadScope inside the service method).
export const retryShopifyPaymentSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await ordersService.retryShopifyPaymentSync(req.user!, value.id);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Cancel/Revert. RBAC is server-side (getLeadScope inside cancelOrder), the same convention as every
// other single-order action here - the route-level role gate is only the coarse "can this role ever
// manage orders" check.
export const cancelOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) {
      sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const body = validateCancelOrder(req.body ?? {});
    if (body.error) {
      sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await ordersService.cancelOrder(req.user!, params.value.id, body.value);
    sendResponse(res, true, result, result.alreadyCancelled ? "This order was already cancelled" : "Order cancelled", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getLastShippingAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : "";
    if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
      sendResponse(res, false, null, "Invalid customer id", STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await ordersService.getLastShippingAddress(req.user!, leadId), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrderFilterOptions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await ordersService.getFilterOptions(req.user!);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
