import { Router } from "express";
import { requireAuth } from "@/middlewares/auth.js";
import { listProducts } from "./products.controller.js";

const router = Router();

// Read-only catalog reference, needed by the manual "Create Order" flow's product picker - not
// scoped by lead (the catalog is the same for every role), only by authentication.
router.get("/", requireAuth, listProducts);

export default router;
