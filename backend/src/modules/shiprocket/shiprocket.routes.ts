import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { assignAwb, generateLabel, listCouriers, refreshTracking, schedulePickup } from "./shiprocket.controller.js";

const router = Router();

// Mounted at /api/shipments. Shipping is an operational step, so every action here is ADMIN/MANAGER; lead scope (the same
// rule every order read uses) then decides WHICH orders a manager can act on. Salespersons keep read access to shipments
// through the order detail, as before.
const managers = requireRole(Role.ADMIN, Role.MANAGER);

router.get("/:shipmentId/couriers", requireAuth, managers, listCouriers);
router.post("/:shipmentId/assign-awb", requireAuth, managers, assignAwb);
router.post("/:shipmentId/pickup", requireAuth, managers, schedulePickup);
router.post("/:shipmentId/label", requireAuth, managers, generateLabel);
router.post("/:shipmentId/refresh-tracking", requireAuth, managers, refreshTracking);

export default router;
