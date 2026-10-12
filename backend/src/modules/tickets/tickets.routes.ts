import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { addTicketComment, createTicket, getOpenTicketCount, getTicket, listTickets, setTicketStatus } from "./tickets.controller.js";

const router = Router();

router.use(requireAuth);

// Salesperson raises; the service scopes every read to own / direct reports / everyone by role.
router.post("/", requireRole(Role.SALESPERSON), createTicket);
router.get("/", requireRole(Role.SALESPERSON, Role.MANAGER, Role.ADMIN), listTickets);
router.get("/open-count", requireRole(Role.SALESPERSON, Role.MANAGER, Role.ADMIN), getOpenTicketCount);
router.get("/:id", requireRole(Role.SALESPERSON, Role.MANAGER, Role.ADMIN), getTicket);
router.post("/:id/comments", requireRole(Role.SALESPERSON, Role.MANAGER, Role.ADMIN), addTicketComment);
router.patch("/:id/status", requireRole(Role.SALESPERSON, Role.MANAGER, Role.ADMIN), setTicketStatus);

export default router;
