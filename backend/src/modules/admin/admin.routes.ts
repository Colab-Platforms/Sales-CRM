import { Router } from "express";
import {
  createManager,
  listManagers,
  getManager,
  updateManager,
  deactivateManager,
  createSalesperson,
  listSalespersons,
  updateSalesperson,
} from "./admin.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth, requireRole(Role.ADMIN));

router.post("/managers", createManager);
router.get("/managers", listManagers);
router.get("/managers/:id", getManager);
router.patch("/managers/:id", updateManager);
router.delete("/managers/:id", deactivateManager);

router.post("/salespersons", createSalesperson);
router.get("/salespersons", listSalespersons);
router.patch("/salespersons/:id", updateSalesperson);

export default router;
