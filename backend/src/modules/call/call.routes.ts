import { Router, type RequestHandler } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getCall, getCallSummary, initiateCall, listCalls } from "./call.controller.js";

/**
 * `initiateHandler`/`listHandler`/`getHandler`/`summaryHandler` are each independently injectable
 * (all default to the real ones) so existing tests that only override `initiateHandler` - e.g.
 * `createCallRouter(createInitiateCallHandler(() => fakeService))` - keep working unchanged, while
 * new tests can override just the read handlers the same way.
 */
export function createCallRouter(
  initiateHandler: RequestHandler = initiateCall as unknown as RequestHandler,
  listHandler: RequestHandler = listCalls as unknown as RequestHandler,
  getHandler: RequestHandler = getCall as unknown as RequestHandler,
  summaryHandler: RequestHandler = getCallSummary as unknown as RequestHandler,
): Router {
  const router = Router();

  // Every role that may place a call may also see call history - lead-level scoping (which calls
  // each role actually sees) happens inside call.history.service.ts, not here. This same read
  // surface backs both the plain Call History page and the IVR Inbound/Outbound reporting pages -
  // there is no separate IVR-only route group.
  router.use(requireAuth);
  const roles = requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON);

  // Registered before "/:id" so "/" (the list) and "/summary" are never read as a call id.
  router.get("/", roles, listHandler);
  router.get("/summary", roles, summaryHandler);
  router.get("/:id", roles, getHandler);
  router.post("/", roles, initiateHandler);

  return router;
}

export default createCallRouter();
