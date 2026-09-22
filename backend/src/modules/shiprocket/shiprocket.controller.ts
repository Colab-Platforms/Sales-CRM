import type { Response } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import ShiprocketShipmentsService from "./shiprocket.shipments.service.js";
import { validateAssignBody, validateCreateBody, validateListQuery, validateOrderParams, validateShipmentParams } from "./shiprocket.validators.js";

const service = new ShiprocketShipmentsService();

const fail = (res: Response, error: any) => sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
const bad = (res: Response, message: string) => sendResponse(res, false, null, message, STATUS_CODES.BAD_REQUEST);

export const createShipment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateOrderParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateCreateBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await service.createShipment(req.user!, params.value.orderId, body.value), "Shipment created", STATUS_CODES.CREATED);
  } catch (error: any) {
    fail(res, error);
  }
};

export const listCouriers = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateShipmentParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    sendResponse(res, true, await service.getCouriers(req.user!, params.value.shipmentId), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const assignAwb = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateShipmentParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    const body = validateAssignBody(req.body);
    if (body.error) return void bad(res, body.error.message);
    sendResponse(res, true, await service.assignAwb(req.user!, params.value.shipmentId, body.value.courierId), "AWB assigned", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

const simple =
  (run: (user: NonNullable<AuthRequest["user"]>, shipmentId: string) => Promise<unknown>, message: string) =>
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const params = validateShipmentParams(req.params);
      if (params.error) return void bad(res, params.error.message);
      sendResponse(res, true, await run(req.user!, params.value.shipmentId), message, STATUS_CODES.OK);
    } catch (error: any) {
      fail(res, error);
    }
  };

export const schedulePickup = simple((u, id) => service.schedulePickup(u, id), "Pickup scheduled");
export const generateLabel = simple((u, id) => service.generateLabel(u, id), "Label generated");
export const refreshTracking = simple((u, id) => service.refreshTracking(u, id), "Tracking refreshed");

// ---- centralized listing/tracking page ----

export const listShipments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { error, value } = validateListQuery(req.query);
    if (error) return void bad(res, error.message);
    sendResponse(res, true, await service.listShipments(req.user!, value), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getShipment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const params = validateShipmentParams(req.params);
    if (params.error) return void bad(res, params.error.message);
    sendResponse(res, true, await service.getShipmentDetail(req.user!, params.value.shipmentId), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const getShipmentFilterOptions = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    sendResponse(res, true, await service.getFilterOptions(req.user!), "OK", STATUS_CODES.OK);
  } catch (error: any) {
    fail(res, error);
  }
};

export const shiprocketStatus = () => service.status();
