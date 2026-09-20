import { Router } from "express";
import {
  createGroup,
  listMyGroups,
  getGroup,
  updateGroup,
  deleteGroup,
  listSalespersons,
  listMySalespersons,
  createSalesperson,
  addNewSalesperson,
  addExistingSalesperson,
  updateSalesperson,
  removeSalesperson,
} from "./manager.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth, requireRole(Role.MANAGER));

router.post("/groups", createGroup);
router.get("/groups", listMyGroups);
router.get("/groups/:groupId", getGroup);
router.get("/salespersons", listSalespersons);
router.get("/salespersons/mine", listMySalespersons);
router.post("/salespersons", createSalesperson);
router.patch("/groups/:groupId", updateGroup);
router.delete("/groups/:groupId", deleteGroup);
router.post("/groups/:groupId/members", addNewSalesperson);
router.post("/groups/:groupId/members/existing", addExistingSalesperson);
router.patch("/groups/:groupId/members/:userId", updateSalesperson);
router.delete("/groups/:groupId/members/:userId", removeSalesperson);

export default router;
