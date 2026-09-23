import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { getCustomer360, getCustomerTimeline, getNextBestAction, listCustomers } from "./customers.controller.js";

const router = Router();

// Registered before "/:leadId" so "/" (the list) is never read as a customer id.
router.get("/", requireAuth, listCustomers);
router.get("/:leadId", requireAuth, getCustomer360);
router.get("/:leadId/timeline", requireAuth, getCustomerTimeline);
router.get("/:leadId/next-best-action", requireAuth, getNextBestAction);

export default router;
