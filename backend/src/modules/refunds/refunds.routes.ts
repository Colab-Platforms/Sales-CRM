import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { approveRefundRequest, getPendingRefundCount, listRefundRequests, rejectRefundRequest } from "./refunds.controller.js";

const router = Router();

// Mounted at /api/refund-requests. Raising a request is POST /api/orders/:orderId/refund-requests (orders.routes.ts), open to every role under
// the normal order scope. Reviewing - the queue, the badge count, approve and reject - is MANAGER / ADMIN only; scope and the "not your own request"
// rule are enforced again inside the service.
router.get("/", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), listRefundRequests);
router.get("/pending-count", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getPendingRefundCount);
router.post("/:id/approve", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), approveRefundRequest);
router.post("/:id/reject", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), rejectRefundRequest);

export default router;
