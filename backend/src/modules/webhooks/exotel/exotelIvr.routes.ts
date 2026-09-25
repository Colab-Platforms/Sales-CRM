import { Router } from "express";
import express from "express";
import { handleExotelIvrWebhook } from "./exotelIvr.controller.js";

const router = Router();

// PRIMARY: actual Exotel Passthru integration. Exotel calls the configured
// application URL via GET with URL-encoded query parameters (CallSid,
// CallFrom, CallTo, digits, etc.) — see payloadExtractors.ts.
router.get("/ivr", handleExotelIvrWebhook);

// DEV/TEST ONLY: retained for local testing and backward compatibility with
// earlier manual JSON/form-encoded testing. Not the real Exotel integration
// path. Global server.ts already applies express.json(); this adds
// urlencoded parsing scoped to this route only.
router.post("/ivr", express.urlencoded({ extended: true }), handleExotelIvrWebhook);

export default router;
