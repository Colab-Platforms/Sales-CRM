import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { exportAbandoned, exportDashboard, getAbandoned, getAbandonedChart, getChart, getDashboard, getTelecaller } from "./orders.dashboard.controller.js";

// Orders Dashboard: ADMIN and MANAGER only (telecallers, HR and recruiters get 403). The service checks the role again.
const router = Router();
router.use(requireAuth, requireRole(Role.ADMIN, Role.MANAGER));
router.get("/", getDashboard);
router.get("/export", exportDashboard);
router.get("/chart", getChart);
router.get("/telecaller", getTelecaller); // Telecaller Performance: the Reports attribution and money rules (read-only)
router.get("/abandoned/chart", getAbandonedChart);
router.get("/abandoned", getAbandoned);
router.get("/abandoned/export", exportAbandoned);

export default router;
