import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import * as c from "./incentives.controller.js";

const router = Router();

router.use(requireAuth);

// Salesperson: only their own month (the id comes from the login), and queries about it.
router.get("/me", requireRole(Role.SALESPERSON), c.getMyMonth);
router.post("/me/queries", requireRole(Role.SALESPERSON), c.raiseQuery);

// Admin: everyone's months, the policy, approval, payment, queries and the audit log.
const admin = requireRole(Role.ADMIN);
router.get("/overview", admin, c.getOverview);
router.get("/policy", admin, c.getPolicy);
router.put("/policy", admin, c.setPolicy);
router.get("/queries", admin, c.listQueries);
router.post("/queries/:id/resolve", admin, c.resolveQuery);
router.get("/audit", admin, c.getAudit);
router.get("/salespeople/:userId/:month", admin, c.getSalespersonMonth);
router.post("/salespeople/:userId/:month/approve", admin, c.approveMonth);
router.post("/salespeople/:userId/:month/payment", admin, c.recordPayment);

export default router;
