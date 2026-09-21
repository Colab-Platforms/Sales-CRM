import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { sendResponse } from "@/utils/responseUtils.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { cashfreeStatus } from "../cashfree/cashfree.controller.js";
import { shiprocketStatus } from "../shiprocket/shiprocket.controller.js";

const router = Router();

// Lets the UI show or hide the payment-link and shipment actions. Booleans and an environment name only - never a credential.
router.get("/status", requireAuth, (_req, res) => {
  sendResponse(res, true, { cashfree: cashfreeStatus(), shiprocket: shiprocketStatus() }, "OK", STATUS_CODES.OK);
});

export default router;
