import { Router } from "express";
import { requireAuth, requireRole } from "@/middlewares/auth.js";
import { Role } from "../../../generated/prisma/enums.js";
import { catalogUpload } from "@/middlewares/upload.js";
import { downloadCatalogImportFailures, getCatalogImportStatus, listProducts, setProductWeight, startCatalogImportRequest } from "./products.controller.js";

const router = Router();

// Read-only catalog reference, needed by the manual "Create Order" flow's product picker - not
// scoped by lead (the catalog is the same for every role), only by authentication.
router.get("/", requireAuth, listProducts);
// Recording the real unit weight (informational) of a product / variant: ADMIN and MANAGER only. null clears it.
router.post("/catalog-import", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), catalogUpload.single("file"), startCatalogImportRequest);
router.get("/catalog-import/:jobId", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), getCatalogImportStatus);
router.get("/catalog-import/:jobId/failed-rows", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), downloadCatalogImportFailures);
router.put("/variants/:id/weight", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), setProductWeight("variant"));
router.put("/:id/weight", requireAuth, requireRole(Role.ADMIN, Role.MANAGER), setProductWeight("product"));

export default router;
