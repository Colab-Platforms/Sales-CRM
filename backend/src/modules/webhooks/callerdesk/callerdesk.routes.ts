import express, { Router, type RequestHandler } from "express";
import { handleCallerDeskMethodNotAllowed, handleCallerDeskWebhook } from "./callerdesk.controller.js";

export function createCallerDeskRouter(webhookHandler: RequestHandler = handleCallerDeskWebhook): Router {
  const router = Router();

  // CallerDesk sends event data as JSON via HTTP POST (global express.json() in server.ts).
  // urlencoded parsing is added for this route only as a tolerant fallback.
  // NOTE: system-to-system endpoint - deliberately NOT behind requireAuth (see controller header).
  router.post("/", express.urlencoded({ extended: true }), webhookHandler);

  // Anything other than POST is rejected explicitly.
  router.all("/", handleCallerDeskMethodNotAllowed);

  return router;
}

export default createCallerDeskRouter();
