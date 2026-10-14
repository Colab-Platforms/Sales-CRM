import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  bulkAssignManager,
  bulkAssignSalesperson,
  bulkUpdateLeadStatus,
  createRecoveryAction,
  getAbandonment,
  getAbandonmentByLead,
  getAbandonmentDistribution,
  getIngestionStatusHandler,
  reconcileIngestionHandler,
  getMyAbandonmentSummary,
  listAssignableTelecallers,
  getAbandonmentOrderPrefill,
  listAbandonmentIds,
  listAbandonmentItems,
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
// Who may LIST abandoned leads and see the distribution: HR does so for lead distribution only (it cannot open a lead, its cart/address prefill, or work it).
const listRoles = requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON, Role.HR);
// Who may assign abandoned leads to telecallers (enforced again in AbandonmentService.bulkAssignSalesperson).
const assignRoles = requireRole(Role.ADMIN, Role.MANAGER, Role.HR);

router.get("/", requireAuth, listRoles, listAbandonments);
// Items filter: the products found in the viewer's abandoned carts, and the ids of everything a filter matches ("Select all").
router.get("/items", requireAuth, listRoles, listAbandonmentItems);
router.get("/ids", requireAuth, listRoles, listAbandonmentIds);
// Lead distribution by telecaller (admin / manager / HR - never a telecaller), a telecaller's own summary, and who can be assigned. Registered ahead of "/:id".
router.get("/distribution", requireAuth, assignRoles, getAbandonmentDistribution);
router.get("/my-summary", requireAuth, requireRole(Role.SALESPERSON), getMyAbandonmentSummary);
router.get("/telecallers", requireAuth, assignRoles, listAssignableTelecallers);
// Fastrr ingestion health (admin / manager / HR; counts and times only) and the admin-only, bounded re-processing of deliveries that failed for good.
router.get("/ingestion/status", requireAuth, assignRoles, getIngestionStatusHandler);
router.post("/ingestion/reconcile", requireAuth, requireRole(Role.ADMIN), reconcileIngestionHandler);
// Backs the "Abandoned Checkout" panel embedded on the normal lead-detail page - looked up by leadId.
router.get("/by-lead/:leadId", requireAuth, allRoles, getAbandonmentByLead);

// Auto-assignment toggles - registered ahead of "/:id" so these paths aren't swallowed by it.
router.get("/auto-assign/manager-config", requireAuth, requireRole(Role.ADMIN), getManagerAutoAssignConfig);
router.patch("/auto-assign/manager-config", requireAuth, requireRole(Role.ADMIN), updateManagerAutoAssignConfig);
router.get("/auto-assign/salesperson-config", requireAuth, requireRole(Role.MANAGER), getSalespersonAutoAssignConfig);
router.patch("/auto-assign/salesperson-config", requireAuth, requireRole(Role.MANAGER), updateSalespersonAutoAssignConfig);

router.get("/:id", requireAuth, allRoles, getAbandonment);
// The saved cart + address of this one checkout, for the Create Order form.
router.get("/:id/order-prefill", requireAuth, allRoles, getAbandonmentOrderPrefill);
router.post("/:id/recovery-actions", requireAuth, allRoles, createRecoveryAction);
router.patch("/:id/status", requireAuth, allRoles, updateAbandonmentStatus);

router.post("/bulk/assign-manager", requireAuth, requireRole(Role.ADMIN), bulkAssignManager);
router.post("/bulk/assign-salesperson", requireAuth, assignRoles, bulkAssignSalesperson);
router.post("/bulk/update-lead-status", requireAuth, requireRole(Role.ADMIN), bulkUpdateLeadStatus);

export default router;
