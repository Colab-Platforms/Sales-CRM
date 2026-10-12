import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import {
  endShift,
  getMyShift,
  getReport,
  getTeam,
  heartbeat,
  setStatus,
  startShift,
  streamMyPresence,
  streamTeam,
} from "./attendance.controller.js";

const router = Router();

router.use(requireAuth);

// Salesperson: their own shift.
router.post("/start", requireRole(Role.SALESPERSON), startShift);
router.post("/status", requireRole(Role.SALESPERSON), setStatus);
router.post("/heartbeat", requireRole(Role.SALESPERSON), heartbeat);
router.post("/end", requireRole(Role.SALESPERSON), endShift);
router.get("/me", requireRole(Role.SALESPERSON), getMyShift);
router.get("/stream", requireRole(Role.SALESPERSON), streamMyPresence);

// Manager (direct reports) / admin (everyone): live board.
router.get("/team", requireRole(Role.ADMIN, Role.MANAGER), getTeam);
router.get("/team/stream", requireRole(Role.ADMIN, Role.MANAGER), streamTeam);

// Daily report; a salesperson is limited to their own row by the service.
router.get("/report", requireRole(Role.ADMIN, Role.MANAGER, Role.SALESPERSON), getReport);

export default router;
