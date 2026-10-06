import { Router, type RequestHandler } from "express";
import { handleWebsiteChatMethodNotAllowed, handleWebsiteChatWebhook } from "./website-chat.controller.js";

export function createWebsiteChatRouter(webhookHandler: RequestHandler = handleWebsiteChatWebhook): Router {
  const router = Router();

  // System-to-system endpoint from the separate Aayush-AI-Commerce chatbot backend - deliberately
  // NOT behind requireAuth (CRM JWTs are never accepted here, see controller header). Body is
  // parsed as JSON by the global express.json() in server.ts, same as every other non-raw-body
  // webhook route.
  router.post("/", webhookHandler);

  router.all("/", handleWebsiteChatMethodNotAllowed);

  return router;
}

export default createWebsiteChatRouter();
