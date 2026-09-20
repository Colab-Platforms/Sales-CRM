import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getReconciliation } from "../reconciliation/reconciliation.controller.js";
import { getOrder, getOrderFilterOptions, getOrderStatusHistory, listOrders } from "./orders.controller.js";

const router = Router();

// Registered before "/:id" so "filter-options"/"reconciliation" are not read as an order id.
router.get("/filter-options", requireAuth, getOrderFilterOptions);
// Revenue & payment reconciliation is an org/team-level financial view, not a single order - only
// management roles get it, same as the rest of the manager/admin-only reporting endpoints.
router.get("/reconciliation", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getReconciliation);
router.get("/", requireAuth, listOrders);
router.get("/:id", requireAuth, getOrder);
router.get("/:id/status-history", requireAuth, getOrderStatusHistory);

export default router;
