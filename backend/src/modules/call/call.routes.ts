import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { initiateCall } from "./call.controller.js";

export function createCallRouter(handler: RequestHandler = initiateCall as unknown as RequestHandler): Router {
  const router = Router();

  // Every call is placed by an authenticated CRM user; lead-level authorisation is in call.service.ts.
  router.use(requireAuth);
  router.post("/", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), handler);

  return router;
}

export default createCallRouter();
