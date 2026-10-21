import { Router } from "express";
import type { Response } from "express";
import { prisma } from "@/lib/prisma.js";
import type { AuthRequest } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { getLeadScope, getOrderFlowScope } from "@/lib/leadScope.js";
import { orderReadWhere, scopedOrderWhere } from "../orders/orders.filters.js";
import type { Db } from "../integrations/integrations.common.js";
import { loadPaymentQrPng, renderStoredPaymentQr, sendPaymentQr } from "./whatsapp.payment-qr.js";

// PUBLIC (no login - WhatsApp's servers fetch it): the QR image of one open Cashfree payment link. Mounted at /api/public/payment-qr.
// The signed path (id + stored random token) is the only credential: a wrong token, a payment that is not an open Cashfree link, or an expired one all answer the same 404.
export function createPublicQrRoutes(db: Db = prisma): Router {
  const router = Router();
  router.get("/:paymentId/:file", async (req, res) => {
  const file = /^([0-9a-f]{32})\.png$/.exec(String(req.params.file));
  let png: Buffer | null = null;
  try {
    png = file ? await loadPaymentQrPng(db, String(req.params.paymentId), file[1]!) : null;
  } catch {
    png = null;
  }
  if (!png) {
    res.status(404).json({ success: false, message: "Not found", data: null });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.send(png);
  });
  return router;
}
export const publicQrRoutes = createPublicQrRoutes();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /orders/:orderId/payment-links/:paymentId/qr - the retry for a QR image that was not delivered: same order, same payment link, only the image is sent again. The caller must be allowed to work this
 * order (same scope as creating its payment link); the route restricts the roles. A delivery problem is a normal answer (status NOT_SENT / FAILED with a reason), not an error.
 */
/**
 * GET /orders/:orderId/payment-links/:paymentId/qr - the payment's QR card as a PNG, for the order page (an <img> cannot send the login header, so the browser loads it as a blob). Same visibility as reading the order.
 * Display only: it creates nothing and changes nothing.
 */
export const viewPaymentLinkQr = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = String(req.params.orderId);
    const paymentId = String(req.params.paymentId);
    if (!UUID.test(orderId) || !UUID.test(paymentId)) throw new ApiError("Invalid order or payment id", STATUS_CODES.BAD_REQUEST);
    const order = await prisma.order.findFirst({ where: orderReadWhere(req.user!, orderId, await getLeadScope(req.user!, prisma)), select: { id: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    const image = await renderStoredPaymentQr(prisma, paymentId, order.id);
    if (!image) throw new ApiError("This payment has no Cashfree payment link to show a QR code for.", STATUS_CODES.NOT_FOUND);
    res.status(STATUS_CODES.OK);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Length", String(image.png.length));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.end(image.png);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};

export const sendPaymentLinkQr = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const orderId = String(req.params.orderId);
    const paymentId = String(req.params.paymentId);
    if (!UUID.test(orderId) || !UUID.test(paymentId)) throw new ApiError("Invalid order or payment id", STATUS_CODES.BAD_REQUEST);
    const order = await prisma.order.findFirst({ where: scopedOrderWhere(orderId, await getOrderFlowScope(req.user!, prisma)), select: { id: true } });
    if (!order) throw new ApiError("Order not found", STATUS_CODES.NOT_FOUND);
    const result = await sendPaymentQr(prisma, req.user!, paymentId, {}, { force: true, orderId });
    sendResponse(res, true, result, result.status === "SENT" ? "QR code sent" : result.reason ?? "QR code not sent", STATUS_CODES.OK);
  } catch (error: any) {
    sendResponse(res, false, null, error.message, error.statusCode ?? STATUS_CODES.SERVER_ERROR);
  }
};
