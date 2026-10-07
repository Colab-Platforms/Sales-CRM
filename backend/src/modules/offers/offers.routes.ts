import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getActiveOffers } from "./offers.controller.js";

const router = Router();

// Read-only, for every CRM role that works with customers/orders (the roles are ADMIN, MANAGER and SALESPERSON -
// "telecaller" users are SALESPERSON). No write routes exist for offers.
router.get("/active", requireAuth, requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getActiveOffers);

export default router;
