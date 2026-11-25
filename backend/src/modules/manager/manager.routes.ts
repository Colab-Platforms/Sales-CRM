import { Router } from "express";
import { listMyGroups, getGroup, listMySalespersons, getAnalyticsOverview, getSalespersonAnalytics, exportSalesOrdersCsv, getSegmentReport, getSegmentLeadHistory, exportSegmentReport, getSegmentDetails, exportSegmentDetails } from "./manager.controller.js";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";

const router = Router();

router.use(requireAuth);

// Manager has read-only visibility into their own team — all team/salesperson
// mutations (create/edit/delete) now live with Admin/HR only.
const managerOnly = requireRole(Role.MANAGER);
router.get("/groups", managerOnly, listMyGroups);
router.get("/groups/:groupId", managerOnly, getGroup);
router.get("/salespersons/mine", managerOnly, listMySalespersons);

// Sales reports: a manager sees their own team, an admin sees every team. No other role.
const reportViewers = requireRole(Role.MANAGER, Role.ADMIN);
router.get("/analytics", reportViewers, getAnalyticsOverview);
router.get("/analytics/orders.csv", reportViewers, exportSalesOrdersCsv);
router.get("/analytics/segment", reportViewers, getSegmentReport);
router.get("/analytics/segment/export.xlsx", reportViewers, exportSegmentReport);
router.get("/analytics/segment/leads/:leadId/history", reportViewers, getSegmentLeadHistory);
router.get("/analytics/segment/details", reportViewers, getSegmentDetails);
router.get("/analytics/segment/details/export.xlsx", reportViewers, exportSegmentDetails);
router.get("/analytics/salespersons/:salespersonId", reportViewers, getSalespersonAnalytics);

export default router;
