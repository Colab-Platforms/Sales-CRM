import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { cancelPaymentLink, refreshPaymentLink, sendPaymentLinkWhatsApp } from "./cashfree.controller.js";

const router = Router();

// Mounted at /api/payments. Lead scope (the same rule every order read uses) decides WHICH orders a user can act on.
// On top of that: creating/sending/refreshing a link is open to every role, so a salesperson can collect on their own
// customers' orders; cancelling a link someone may already be about to pay is ADMIN/MANAGER only.
router.post("/:paymentId/refresh", requireAuth, refreshPaymentLink);
router.post("/:paymentId/send-whatsapp", requireAuth, sendPaymentLinkWhatsApp);
router.post("/:paymentId/cancel-link", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), cancelPaymentLink);

export default router;
