import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  bulkAssignManager,
  bulkAssignSalesperson,
  createRecoveryAction,
  getAbandonment,
  getAbandonmentByLead,
  listAbandonments,
  updateAbandonmentStatus,
} from "./abandonment.controller.js";
import {
  getManagerAutoAssignConfig,
  getSalespersonAutoAssignConfig,
  updateManagerAutoAssignConfig,
  updateSalespersonAutoAssignConfig,
} from "./abandonment.auto-assign.controller.js";

const router = Router();

// Mounted at /api/abandonments. Abandoned leads are worked the same as normal leads: ADMIN assigns to
// a manager, the manager assigns to a salesperson, and each role's queue is scoped to what's assigned
// to them (AbandonmentService.scopeWhere) - same assignedManagerId/ownerId fields as the Lead itself.
const allRoles = requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON);

router.get("/", requireAuth, allRoles, listAbandonments);
// Backs the "Abandoned Checkout" panel embedded on the normal lead-detail page - looked up by leadId.
router.get("/by-lead/:leadId", requireAuth, allRoles, getAbandonmentByLead);

// Auto-assignment toggles - registered ahead of "/:id" so these paths aren't swallowed by it.
router.get("/auto-assign/manager-config", requireAuth, requireRole(Role.ADMIN), getManagerAutoAssignConfig);
router.patch("/auto-assign/manager-config", requireAuth, requireRole(Role.ADMIN), updateManagerAutoAssignConfig);
router.get("/auto-assign/salesperson-config", requireAuth, requireRole(Role.MANAGER), getSalespersonAutoAssignConfig);
router.patch("/auto-assign/salesperson-config", requireAuth, requireRole(Role.MANAGER), updateSalespersonAutoAssignConfig);

router.get("/:id", requireAuth, allRoles, getAbandonment);
router.post("/:id/recovery-actions", requireAuth, allRoles, createRecoveryAction);
router.patch("/:id/status", requireAuth, allRoles, updateAbandonmentStatus);

router.post("/bulk/assign-manager", requireAuth, requireRole(Role.ADMIN), bulkAssignManager);
router.post("/bulk/assign-salesperson", requireAuth, requireRole(Role.MANAGER), bulkAssignSalesperson);

export default router;
