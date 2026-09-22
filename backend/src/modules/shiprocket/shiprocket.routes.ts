import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { assignAwb, generateLabel, getShipment, getShipmentFilterOptions, listCouriers, listShipments, refreshTracking, schedulePickup } from "./shiprocket.controller.js";

const router = Router();

// Mounted at /api/shipments. Shipping is an operational step, so every action here is ADMIN/MANAGER; lead scope (the same
// rule every order read uses) then decides WHICH orders a manager can act on. Salespersons keep read access to shipments
// through the order detail, as before.
const managers = requireRole(Role.ADMIN, Role.MANAGER);

// Registered before "/:shipmentId" so "filter-options" is never read as a shipment id - same convention as
// orders.routes.ts's "/filter-options" before "/:id". The centralized Shiprocket listing/tracking page.
router.get("/filter-options", requireAuth, managers, getShipmentFilterOptions);
router.get("/", requireAuth, managers, listShipments);
router.get("/:shipmentId", requireAuth, managers, getShipment);

router.get("/:shipmentId/couriers", requireAuth, managers, listCouriers);
router.post("/:shipmentId/assign-awb", requireAuth, managers, assignAwb);
router.post("/:shipmentId/pickup", requireAuth, managers, schedulePickup);
router.post("/:shipmentId/label", requireAuth, managers, generateLabel);
router.post("/:shipmentId/refresh-tracking", requireAuth, managers, refreshTracking);

export default router;
