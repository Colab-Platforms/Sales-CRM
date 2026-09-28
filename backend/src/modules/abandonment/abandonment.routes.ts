import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { createRecoveryAction, getAbandonment, listAbandonments, updateAbandonmentStatus } from "./abandonment.controller.js";

const router = Router();

// Mounted at /api/abandonments. Working an abandoned cart is an ADMIN/MANAGER operation, same as
// /api/shipments - lead scope (getLeadScope) then decides which abandonments a manager can see/act on.
// Salespersons see their own leads' abandonment history through Customer 360 instead (already built).
const managers = requireRole(Role.ADMIN, Role.MANAGER);

router.get("/", requireAuth, managers, listAbandonments);
router.get("/:id", requireAuth, managers, getAbandonment);
router.post("/:id/recovery-actions", requireAuth, managers, createRecoveryAction);
router.patch("/:id/status", requireAuth, managers, updateAbandonmentStatus);

export default router;
