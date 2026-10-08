import { Router } from "express";
import { listMyGroups, getGroup, listMySalespersons } from "./manager.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth, requireRole(Role.MANAGER));

// Manager has read-only visibility into their own team — all team/salesperson
// mutations (create/edit/delete) now live with Admin/HR only.
router.get("/groups", listMyGroups);
router.get("/groups/:groupId", getGroup);
router.get("/salespersons/mine", listMySalespersons);

export default router;
