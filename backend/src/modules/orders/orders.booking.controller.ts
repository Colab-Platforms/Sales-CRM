import type { Response } from "express";
import type { AuthRequest } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import OrderBookingService from "./orders.booking.service.js";
import {
  validateCatalogQuery,
  validateCreateBookingBody,
  validateLookupQuery,
  validateQuoteBody,
  validateServiceabilityQuery,
} from "./orders.booking.validators.js";

// E5 on-call booking endpoints. Every input is validated here; every business rule is enforced in the service.

const service = new OrderBookingService();

/** validateSchema returns { error, value }; reject bad input with a clear 400 instead of continuing. */
function valid<T>(result: { error: { message: string } | null; value: T }): T {
  if (result.error) throw new ApiError(result.error.message, STATUS_CODES.BAD_REQUEST);
  return result.value;
}

export async function lookupBookingLeads(req: AuthRequest, res: Response) {
  const { mobile } = valid(validateLookupQuery(req.query));
  res.status(200).json({ success: true, data: await service.lookupLeads(req.user!, mobile) });
}

export async function getBookingCatalog(req: AuthRequest, res: Response) {
  const { search } = valid(validateCatalogQuery(req.query));
  res.status(200).json({ success: true, data: await service.catalog(search) });
}

export async function checkBookingServiceability(req: AuthRequest, res: Response) {
  const { pincode, cod } = valid(validateServiceabilityQuery(req.query));
  res.status(200).json({ success: true, data: await service.checkServiceability(pincode, cod === "true") });
}

export async function quoteBooking(req: AuthRequest, res: Response) {
  const body = valid(validateQuoteBody(req.body));
  res.status(200).json({ success: true, data: await service.quote(body) });
}

export async function createBookingOrder(req: AuthRequest, res: Response) {
  const body = valid(validateCreateBookingBody(req.body));
  const result = await service.createOrder(req.user!, body);
  res.status(result.duplicate ? 200 : 201).json({ success: true, data: result });
}