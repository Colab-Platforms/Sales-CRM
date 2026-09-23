import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import OrdersService from "./orders.service.js";
import { validateCreateManualOrder, validateListOrdersQuery, validateOrderIdParams } from "./orders.validators.js";

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

export const getOrderFilterOptions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const result = await ordersService.getFilterOptions(req.user!);
    sendResponse(res, true, result, "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
