import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { getMatrix } from "./matrix.controller.js";

const router = Router();

router.use(requireAuth);

// Managers see their direct reports; admins every salesperson (optionally one manager's team).
router.get("/", requireRole(Role.ADMIN, Role.MANAGER), getMatrix);

export default router;
