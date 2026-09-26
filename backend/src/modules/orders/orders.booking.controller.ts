import type { Response } from "express";
import type { AuthRequest } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import CashfreePaymentsService, { type PaymentLinkResult } from "../cashfree/cashfree.payments.service.js";
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

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

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

/**
 * US-5.7 + 5.6: place the order, then (for payment-link orders) create the Cashfree link and try to send it on WhatsApp.
 * The order is saved first; a link or WhatsApp problem is reported back but never undoes the order.
 */
export async function createBookingOrder(req: AuthRequest, res: Response) {
  const body = valid(validateCreateBookingBody(req.body));
  const result = await service.createOrder(req.user!, body);

  let paymentLink: PaymentLinkResult | null = null;
  let paymentLinkError: string | null = null;
  let whatsApp: { sent: boolean; reason: string | null } | null = null;

  if (body.paymentMethod === "PAYMENT_LINK" && result.order.status === "PENDING_PAYMENT") {
    const cashfree = new CashfreePaymentsService();
    try {
      // Returns the existing open link on a retry, so a double click never creates two links.
      paymentLink = await cashfree.createPaymentLink(req.user!, result.order.id);
    } catch (error) {
      paymentLinkError = messageOf(error, "Could not create the payment link");
    }

    if (paymentLink) {
      const templateId = process.env.E5_PAYMENT_LINK_TEMPLATE_ID?.trim();
      if (!templateId) {
        whatsApp = { sent: false, reason: "No WhatsApp payment-link template is set up yet — copy the link and share it." };
      } else {
        try {
          await cashfree.sendPaymentLinkWhatsApp(req.user!, paymentLink.paymentId, templateId);
          whatsApp = { sent: true, reason: null };
        } catch (error) {
          whatsApp = { sent: false, reason: messageOf(error, "WhatsApp could not be sent") };
        }
      }
    }
  }

  res.status(result.duplicate ? 200 : 201).json({
    success: true,
    data: { ...result, paymentLink, paymentLinkError, whatsApp },
  });
}