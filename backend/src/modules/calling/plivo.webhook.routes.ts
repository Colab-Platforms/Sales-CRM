import { Router, type Request, type Response } from "express";
import CallingService from "./calling.service.js";
import { buildHangupXml, publicBackendUrl, verifyPlivoSignature } from "./plivo.client.js";
import { logger } from "@/utils/logger.js";
import type { PlivoWebhookParams } from "./calling.types.js";

// Mounted in server.ts ahead of the JSON parser with express.urlencoded (Plivo posts form fields) so the
// params the V3 signature covers are exactly what was sent. Every route verifies that signature and fails
// closed; configure these URLs on the Plivo Application:
//   Answer URL  -> POST <PUBLIC_BACKEND_URL>/api/webhooks/plivo/answer
//   Hangup URL  -> POST <PUBLIC_BACKEND_URL>/api/webhooks/plivo/hangup
// (the dial and recording callbacks are supplied in the answer XML).
const router = Router();
const callingService = new CallingService();

function paramsOf(req: Request): PlivoWebhookParams {
  return (req.body ?? {}) as PlivoWebhookParams;
}

function isSigned(req: Request): boolean {
  return verifyPlivoSignature({
    method: req.method,
    originalUrl: `/api/webhooks/plivo${req.url}`,
    headers: req.headers as Record<string, unknown>,
    params: paramsOf(req),
  });
}

function reject(req: Request, res: Response): void {
  logger.warn(
    `[plivo] webhook rejected: invalid or missing signature url=${publicBackendUrl() ?? "<PUBLIC_BACKEND_URL unset>"}/api/webhooks/plivo${req.url} ` +
      `hasSignature=${Boolean(req.headers["x-plivo-signature-v3"])} hasAuthToken=${Boolean(process.env.PLIVO_AUTH_TOKEN)}`,
  );
  res.status(401).json({ success: false, message: "Invalid signature" });
}

router.post("/answer", async (req, res) => {
  logger.info(`[plivo] answer-url hit from=${paramsOf(req).From} callId=${paramsOf(req)["X-PH-CallId"]}`);
  if (!isSigned(req)) return reject(req, res);
  let xml: string;
  try {
    xml = await callingService.handlePlivoAnswer(paramsOf(req));
  } catch (error) {
    logger.error("[plivo] answer handler failed", error);
    xml = buildHangupXml("Call could not be placed.");
  }
  res.status(200).type("text/xml").send(xml);
});

router.post("/dial", async (req, res) => {
  if (!isSigned(req)) return reject(req, res);
  try {
    await callingService.handlePlivoDialEvent(String(req.query.callId ?? ""), paramsOf(req));
  } catch (error) {
    logger.error("[plivo] dial callback failed", error);
  }
  res.status(200).json({ success: true });
});

router.post("/recording", async (req, res) => {
  if (!isSigned(req)) return reject(req, res);
  try {
    await callingService.handlePlivoRecording(String(req.query.callId ?? ""), paramsOf(req));
  } catch (error) {
    logger.error("[plivo] recording callback failed", error);
  }
  res.status(200).json({ success: true });
});

router.post("/hangup", async (req, res) => {
  if (!isSigned(req)) return reject(req, res);
  try {
    await callingService.handlePlivoHangup(paramsOf(req));
  } catch (error) {
    logger.error("[plivo] hangup callback failed", error);
  }
  res.status(200).json({ success: true });
});

export default router;
