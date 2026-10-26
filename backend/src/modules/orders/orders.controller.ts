import { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import OrdersService from "./orders.service.js";
import { validateCancelOrder, validateChangeFlavour, validateCreateManualOrder, validateListOrdersQuery, validateOrderIdParams, validateOrderItemParams, validateUpdateShippingAddress, validateSyncApply, validateAmountCorrection } from "./orders.validators.js";
import OrderSyncService from "./orders.sync.service.js";
import OrderAmountService from "./orders.amount.service.js";
import OrderEditService from "./orders.edit.service.js";

const ordersService = new OrdersService();
const orderEditService = new OrderEditService();
const orderSyncService = new OrderSyncService();
const orderAmountService = new OrderAmountService();

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

export const listMyOrders = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListOrdersQuery(req.query);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }

    // Always scoped to the authenticated user inside the service: there is no parameter that selects whose orders are listed.
    const result = await ordersService.listMyOrders(req.user!, value);
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
    // From the UI/API a new order that matches a very recent one for the same customer needs an explicit acknowledgement; internal callers (AI order flow, workers) are unaffected.
    const result = await ordersService.createManualOrder(req.user!, { ...value, rejectRecentTwin: !value.acknowledgeDuplicate && !value.supersedesOrderId });
    sendResponse(res, true, result, "Order created", STATUS_CODES.CREATED);
  } catch (error: any) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
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

// Re-verify (and repair supported fields of) an order that is already linked to Shopify. Admin / manager only; never creates an order. RBAC + scope are also enforced in the service.
export const resyncShopifyOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await ordersService.resyncShopifyOrder(req.user!, value.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Manual retry of the "CRM Confirmed by <name>" Shopify tag sync. RBAC is server-side (getLeadScope inside the service method).
export const retryConfirmationTagSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateOrderIdParams(req.params);
    if (error) {
      sendResponse(res, false, null, error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await ordersService.retryConfirmationTagSync(req.user!, value.id), "OK", STATUS_CODES.OK);
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

// Revert a CRM cancellation back to the status recorded at cancel time. Same RBAC as cancelOrder.
export const revertCancellation = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) {
      sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
      return;
    }
    const result = await ordersService.revertCancellation(req.user!, params.value.id);
    sendResponse(res, true, result, result.alreadyActive ? "This order is not cancelled" : "Order cancellation reverted", STATUS_CODES.OK);
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

export const getWhatsAppPaymentOptions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const leadId = typeof req.query.leadId === "string" ? req.query.leadId : "";
    if (!/^[0-9a-f-]{36}$/i.test(leadId)) {
      sendResponse(res, false, null, "Invalid customer id", STATUS_CODES.BAD_REQUEST);
      return;
    }
    sendResponse(res, true, await ordersService.getWhatsAppPaymentOptions(req.user!, leadId), "OK", STATUS_CODES.OK);
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

// Edit an existing order (flavour / delivery address). Admin, Manager and Telecaller; the service enforces the scope and every business rule.
export const getOrderFlavours = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await orderEditService.listFlavours(req.user!, params.value.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const changeOrderFlavour = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderItemParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateChangeFlavour(req.body ?? {});
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
    const result = await orderEditService.changeFlavour(req.user!, params.value.id, params.value.itemId, body.value.variantId);
    sendResponse(res, true, result, result.message, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const updateOrderShippingAddress = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateUpdateShippingAddress(req.body ?? {});
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
    const result = await orderEditService.updateAddress(req.user!, params.value.id, body.value);
    sendResponse(res, true, result, result.message, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Sync / Update from CRM (order page) and the read-only out-of-sync report. The service enforces role, scope, confirmation and every safeguard.
export const previewOrderSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await orderSyncService.preview(req.user!, params.value.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const applyOrderSync = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateSyncApply(req.body ?? {});
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
    const result = await orderSyncService.apply(req.user!, params.value.id, body.value);
    sendResponse(res, true, result, result.message, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const getOrderSyncReport = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await orderSyncService.report(req.user!, { fresh: req.query.fresh === "true" }), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

// Review & Correct Amount (order page): compare the money with Shopify and the courier, and - Admin / Manager only, after explicit confirmation - add the missing COD shipping line.
export const previewOrderAmount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    sendResponse(res, true, await orderAmountService.preview(req.user!, params.value.id), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const correctOrderAmount = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderIdParams(req.params);
    if (params.error) return void sendResponse(res, false, null, params.error.message, STATUS_CODES.BAD_REQUEST);
    const body = validateAmountCorrection(req.body ?? {});
    if (body.error) return void sendResponse(res, false, null, body.error.message, STATUS_CODES.BAD_REQUEST);
    const result = await orderAmountService.apply(req.user!, params.value.id, body.value);
    sendResponse(res, true, result, result.message, STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, error.data ?? null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
