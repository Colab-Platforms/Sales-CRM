import { Router } from "express";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { cashfreeStatus } from "../cashfree/cashfree.controller.js";
import { shiprocketStatus } from "../shiprocket/shiprocket.controller.js";


import {
  listSources,
  getSource,
  createSource,
  updateSource,
  toggleSourceStatus,
  listSourceWebhookEvents,
  verifyProviderChallenge,
  receiveWebhook,
} from "./integrations.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

// Lets the UI show or hide the payment-link and shipment actions. Booleans and an environment name only - never a credential.
router.get("/status", requireAuth, (_req, res) => {
  sendResponse(res, true, { cashfree: cashfreeStatus(), shiprocket: shiprocketStatus() }, "OK", STATUS_CODES.OK);
});

// Public: providers can't send a JWT, these are secured by adapter-level
// signature verification (and Meta's GET handshake token) instead.
router.get("/webhooks/:provider", verifyProviderChallenge);
router.post("/webhooks/:provider", receiveWebhook);

router.use(requireAuth, requireRole(Role.ADMIN));

router.get("/sources", listSources);
router.get("/sources/:id", getSource);
router.post("/sources", createSource);
router.patch("/sources/:id", updateSource);
router.patch("/sources/:id/status", toggleSourceStatus);
router.get("/sources/:id/events", listSourceWebhookEvents);

export default router;
