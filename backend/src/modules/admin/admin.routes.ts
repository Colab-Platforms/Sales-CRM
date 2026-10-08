import { Router } from "express";
import {
  createManager,
  listManagers,
  getManager,
  updateManager,
  deactivateManager,
  resetManagerPassword,
  createSalesperson,
  listSalespersons,
  updateSalesperson,
  resetSalespersonPassword,
  createHr,
  listHr,
  createGroup,
  listGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  addNewSalespersonToGroup,
  addExistingSalespersonToGroup,
  removeSalespersonFromGroup,
} from "./admin.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth);

const adminOnly = requireRole(Role.ADMIN);
const adminOrHr = requireRole(Role.ADMIN, Role.HR);

// Manager accounts: ADMIN + HR can add managers; edit/deactivate/password
// reset stay ADMIN-only.
router.post("/managers", adminOrHr, createManager);
router.get("/managers", adminOrHr, listManagers);
router.get("/managers/:id", adminOrHr, getManager);
router.patch("/managers/:id", adminOnly, updateManager);
router.delete("/managers/:id", adminOnly, deactivateManager);
router.patch("/managers/:id/password", adminOnly, resetManagerPassword);

// HR accounts: ADMIN only.
router.post("/hr", adminOnly, createHr);
router.get("/hr", adminOnly, listHr);

// Salespersons: ADMIN + HR.
router.post("/salespersons", adminOrHr, createSalesperson);
router.get("/salespersons", adminOrHr, listSalespersons);
router.patch("/salespersons/:id", adminOrHr, updateSalesperson);
router.patch("/salespersons/:id/password", adminOrHr, resetSalespersonPassword);

// Groups (teams): ADMIN + HR, org-wide.
router.post("/groups", adminOrHr, createGroup);
router.get("/groups", adminOrHr, listGroups);
router.get("/groups/:groupId", adminOrHr, getGroup);
router.patch("/groups/:groupId", adminOrHr, updateGroup);
router.delete("/groups/:groupId", adminOrHr, deleteGroup);
router.post("/groups/:groupId/members", adminOrHr, addNewSalespersonToGroup);
router.post("/groups/:groupId/members/existing", adminOrHr, addExistingSalespersonToGroup);
router.delete("/groups/:groupId/members/:userId", adminOrHr, removeSalespersonFromGroup);

export default router;
