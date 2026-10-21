import { parse } from "csv-parse/sync";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import { normalizeEmail, normalizeMobile } from "@/lib/leadIdentity.js";
import { ABANDONED_IMPORT_KIND, ABANDONED_IMPORT_MARKER, isAbandonedImportBatch } from "@/lib/importBatchKind.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { AbandonmentStatus, AbandonmentType, ActivitySource, ImportBatchStatus, Role } from "../../../generated/prisma/enums.js";
import { Prisma } from "../../../generated/prisma/client.js";
import LeadService from "../lead/lead.service.js";
import type { ParsedAbandonment } from "../shiprocket/shiprocket.abandonment.mapper.js";
import { ASSIGN_TX_OPTIONS, SAVE_TX_OPTIONS, saveAbandonment } from "../shiprocket/shiprocket.abandonment.processor.js";

// CSV upload of abandoned leads, shaped like the normal lead import (preview a mapped file, then confirm):
// each valid row goes through the SAME save step as a live Shiprocket Checkout delivery (saveAbandonment), so an
// uploaded cart looks and behaves exactly like a webhook one - matched to an existing lead by phone/email, shown in
// the Abandoned Leads list, and auto-assigned by the same toggles.

const leadService = new LeadService();

/** Keeps one confirm request inside a sane time even when the database is slow: every row is its own transaction. */
export const ABANDONED_IMPORT_MAX_ROWS = 500;
const CONFIRM_CONCURRENCY = 5;
const DUPLICATE_REASON = "Already has an open abandoned checkout";

interface StoredRow {
  firstName: string;
  lastName?: string;
  mobile?: string;
  email?: string;
  location?: string;
  cartValue?: string;
  itemNames: string[];
  checkoutUrl?: string;
  abandonedAt?: string;
}

interface RowError {
  row: number;
  reason: string;
}

function parseCartValue(raw: string | undefined): { value?: string; invalid: boolean } {
  const text = raw?.trim();
  if (!text) return { invalid: false };
  const cleaned = text.replace(/[^\d.]/g, "");
  const value = Number(cleaned);
  if (!cleaned || !Number.isFinite(value) || value < 0) return { invalid: true };
  return { value: String(value), invalid: false };
}

/** Product names in one cell: separated by "|", ";" or a line break (never a comma - names contain them). */
function parseItemNames(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[|;\r\n]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function toEvent(row: StoredRow): ParsedAbandonment {
  const cartValue = row.cartValue ?? null;
  return {
    externalId: null,
    firstName: row.firstName,
    lastName: row.lastName ?? null,
    phone: row.mobile ?? null,
    email: row.email ?? null,
    cartValue,
    currency: cartValue ? "INR" : null,
    itemCount: row.itemNames.length || null,
    itemNames: row.itemNames.slice(0, 3),
    items: row.itemNames.map((name) => ({ productId: null, variantId: null, sku: null, name, quantity: null })),
    stage: null,
    abandonedAt: row.abandonedAt ? new Date(row.abandonedAt) : null,
    checkoutUrl: row.checkoutUrl ?? null,
    location: row.location ?? null,
    lines: [],
    totals: { total: cartValue, shipping: null, tax: null, discount: null, discountCodes: [] },
    shippingAddress: null,
    billingAddress: null,
    sourceName: null,
  };
}

/** Runs `task` over `items` with at most `limit` in flight; each task handles its own errors. */
async function inPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  });
  await Promise.all(workers);
}

class AbandonmentImportService {
  async previewImport(user: AuthUser, file: Express.Multer.File, columnMapping: Record<string, string>) {
    const rawRows: Record<string, string>[] = parse(file.buffer, { columns: true, skip_empty_lines: true, trim: true });
    if (rawRows.length > ABANDONED_IMPORT_MAX_ROWS) {
      throw new ApiError(`A file can have at most ${ABANDONED_IMPORT_MAX_ROWS} rows. Split it and upload again.`, STATUS_CODES.BAD_REQUEST);
    }

    const mapped = rawRows.map((row) => {
      const out: Record<string, string> = {};
      for (const [csvColumn, field] of Object.entries(columnMapping)) {
        if (row[csvColumn] !== undefined) out[field] = row[csvColumn];
      }
      return out;
    });

    // A person who already has an open abandoned checkout is flagged instead of getting a second one, so uploading the same file twice is harmless.
    const candidateMobiles = mapped.map((r) => normalizeMobile(r.mobile)).filter((v): v is string => Boolean(v));
    const candidateEmails = mapped.map((r) => normalizeEmail(r.email)).filter((v): v is string => Boolean(v));
    const identity: Prisma.LeadWhereInput[] = [];
    if (candidateMobiles.length) identity.push({ normalizedMobile: { in: candidateMobiles } });
    if (candidateEmails.length) identity.push({ normalizedEmail: { in: candidateEmails } });
    const openCarts = identity.length
      ? await prisma.abandonment.findMany({
          where: { type: AbandonmentType.CHECKOUT, status: { in: [AbandonmentStatus.ACTIVE, AbandonmentStatus.IN_PROGRESS] }, lead: { OR: identity } },
          select: { lead: { select: { normalizedMobile: true, normalizedEmail: true } } },
        })
      : [];
    const openMobiles = new Set(openCarts.map((a) => a.lead.normalizedMobile).filter(Boolean) as string[]);
    const openEmails = new Set(openCarts.map((a) => a.lead.normalizedEmail).filter(Boolean) as string[]);

    const parsedRows: StoredRow[] = [];
    const errorRows: RowError[] = [];
    const seenMobiles = new Set<string>();
    const seenEmails = new Set<string>();

    mapped.forEach((row, index) => {
      const rowNumber = index + 2; // header is row 1
      const firstName = row.firstName?.trim();
      const normalizedMobile = normalizeMobile(row.mobile);
      const normalizedEmail = normalizeEmail(row.email);

      if (!firstName) return void errorRows.push({ row: rowNumber, reason: "Missing firstName" });
      if (!normalizedMobile && !normalizedEmail) return void errorRows.push({ row: rowNumber, reason: "Missing both mobile and email" });

      const cart = parseCartValue(row.cartValue);
      if (cart.invalid) return void errorRows.push({ row: rowNumber, reason: "Invalid cartValue" });

      let abandonedAt: string | undefined;
      if (row.abandonedAt?.trim()) {
        const parsed = new Date(row.abandonedAt.trim());
        if (Number.isNaN(parsed.getTime())) return void errorRows.push({ row: rowNumber, reason: "Invalid abandonedAt (use e.g. 2026-10-21 14:30)" });
        abandonedAt = parsed.toISOString();
      }

      const isDuplicate =
        (normalizedMobile && (openMobiles.has(normalizedMobile) || seenMobiles.has(normalizedMobile))) ||
        (normalizedEmail && (openEmails.has(normalizedEmail) || seenEmails.has(normalizedEmail)));
      if (isDuplicate) return void errorRows.push({ row: rowNumber, reason: DUPLICATE_REASON });

      if (normalizedMobile) seenMobiles.add(normalizedMobile);
      if (normalizedEmail) seenEmails.add(normalizedEmail);

      parsedRows.push({
        firstName,
        lastName: row.lastName?.trim() || undefined,
        mobile: row.mobile?.trim() || undefined,
        email: row.email?.trim() || undefined,
        location: row.location?.trim() || undefined,
        cartValue: cart.value,
        itemNames: parseItemNames(row.items),
        checkoutUrl: row.checkoutUrl?.trim() || undefined,
        abandonedAt,
      });
    });

    const duplicateRows = errorRows.filter((e) => e.reason === DUPLICATE_REASON).length;
    const batch = await prisma.leadImportBatch.create({
      data: {
        fileName: file.originalname,
        uploadedById: user.id,
        status: ImportBatchStatus.DRAFT,
        totalRows: rawRows.length,
        validRows: parsedRows.length,
        duplicateRows,
        invalidRows: errorRows.length - duplicateRows,
        columnMapping: { ...columnMapping, [ABANDONED_IMPORT_MARKER]: ABANDONED_IMPORT_KIND },
        parsedRows: parsedRows as unknown as Prisma.InputJsonValue,
        errorRows: errorRows as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      batchId: batch.id,
      totalRows: batch.totalRows,
      validRows: batch.validRows,
      duplicateRows: batch.duplicateRows,
      invalidRows: batch.invalidRows,
      sampleErrors: errorRows.slice(0, 20),
    };
  }

  async confirmImport(user: AuthUser, batchId: string) {
    const batch = await prisma.leadImportBatch.findUnique({ where: { id: batchId } });
    // A manager may only act on their own batches; reported as 404 so existence is not leaked. Normal-lead batches are not this flow's.
    if (!batch || !isAbandonedImportBatch(batch.columnMapping) || (user.role === Role.MANAGER && batch.uploadedById !== user.id)) {
      throw new ApiError("Import batch not found", STATUS_CODES.NOT_FOUND);
    }
    if (batch.status !== ImportBatchStatus.DRAFT) throw new ApiError("Import batch already processed", STATUS_CODES.CONFLICT);

    const rows = (batch.parsedRows as unknown as StoredRow[]) ?? [];
    if (rows.length === 0) throw new ApiError("No valid rows to import", STATUS_CODES.BAD_REQUEST);

    // Claim the batch before any row is written, so a double click cannot import the file twice.
    const claimed = await prisma.leadImportBatch.updateMany({ where: { id: batch.id, status: ImportBatchStatus.DRAFT }, data: { status: ImportBatchStatus.COMMITTED, committedAt: new Date() } });
    if (claimed.count === 0) throw new ApiError("Import batch already processed", STATUS_CODES.CONFLICT);

    const isManagerImport = user.role === Role.MANAGER;
    let createdCount = 0;
    const failed: RowError[] = [];

    await inPool(rows.map((row, index) => ({ row, index })), CONFIRM_CONCURRENCY, async ({ row, index }) => {
      try {
        const saved = await prisma.$transaction((tx) => saveAbandonment(tx, toEvent(row), new Date(), {
          referenceType: "AbandonmentImportBatch",
          activitySource: ActivitySource.USER,
          createdTitle: "Checkout abandoned (CSV import)",
          updatedTitle: "Checkout abandonment updated (CSV import)",
        }), SAVE_TX_OPTIONS);
        if (!saved.created) return;
        createdCount += 1;

        // Same best-effort split as the webhook path: the save is committed, a failed assignment only leaves the lead unassigned.
        try {
          await prisma.$transaction(async (tx) => {
            const lead = await tx.lead.findUniqueOrThrow({ where: { id: saved.leadId } });
            const withManager = isManagerImport ? await leadService.assignAbandonedLeadToManager(tx, lead, user.id) : lead;
            await leadService.autoAssignAbandonedLead(tx, withManager);
          }, ASSIGN_TX_OPTIONS);
        } catch (error) {
          logger.warn(`abandonment.import assign_failed batch=${batch.id} row=${index + 2} reason=${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
        }
      } catch (error) {
        failed.push({ row: index + 2, reason: error instanceof Error ? error.message.slice(0, 200) : "Could not save this row" });
      }
    });

    await prisma.leadImportBatch.update({
      where: { id: batch.id },
      data: {
        parsedRows: Prisma.DbNull,
        ...(failed.length > 0 ? { errorRows: [...((batch.errorRows as unknown as RowError[]) ?? []), ...failed] as unknown as Prisma.InputJsonValue } : {}),
      },
    });

    return { batchId: batch.id, createdCount, failedCount: failed.length };
  }
}

export default AbandonmentImportService;
