import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma.js";
import { logger } from "@/utils/logger.js";
import { classifyCustomer } from "@/lib/customerClass.js";
import { ActivityType, AssignmentType, ImportBatchStatus, Role } from "../../../../generated/prisma/enums.js";
import { Prisma } from "../../../../generated/prisma/client.js";
import { readCustomer, rowProblem, type ColumnMapping, type ParsedCustomer } from "./import.columns.js";
import { statusFromRow } from "./import.tagging.js";

// BACKGROUND PROCESSING OF A STAGED FILE IMPORT. EVERY valid row becomes its own NEW lead: a phone number or email that already exists in the CRM, or repeats in the file, is NOT a reason to update, merge or skip anything.
// The upload request only stages the rows; this runs afterwards, in small committed chunks:
//  - every chunk is ONE transaction (lead creation, field updates, segment membership, row outcomes, batch counters), so a failure can never leave a chunk half-applied;
//  - rows still PENDING are what is left to do, so a crash or restart resumes exactly where it stopped (resumeInterruptedImports) and nothing is imported twice;
//  - retry safety comes from the ROW (its status moves PENDING -> CREATED in the same transaction as its lead), never from who the customer is: a chunk is either fully applied or not at all, so a retry cannot create a row's lead twice.

export const CHUNK_SIZE = 500;
const DEFAULT_SOURCE = "Customer Import";

export type BatchContext = {
  batchId: string;
  mapping: ColumnMapping;
  segmentId: string | null;
  uploaderId: string;
  uploaderRole: Role;
};

type RowOutcome = { id: number; status: "CREATED" | "UPDATED" | "DUPLICATE" | "FAILED"; reason: string | null; leadId: string | null };

/** What a customer file carried that the lead has no column for: structured, so nothing is lost. */
export function buildImportData(c: ParsedCustomer): { fields: Record<string, string>; extra: Record<string, string> } | null {
  const fields: Record<string, string> = {};
  const put = (k: string, v: string | null) => {
    if (v) fields[k] = v;
  };
  put("city", c.city);
  put("state", c.state);
  put("address", c.address);
  put("pincode", c.pincode);
  put("product", c.product);
  put("paymentInfo", c.paymentInfo);
  if (c.lastOrderAt) fields.lastOrderDate = c.lastOrderAt.toISOString().slice(0, 10);
  if (Object.keys(fields).length === 0 && Object.keys(c.extra).length === 0) return null;
  return { fields, extra: { ...c.extra } };
}

type ImportData = { fields?: Record<string, string>; extra?: Record<string, string>; [k: string]: unknown };

/** New non-empty values overwrite; everything the lead already had stays. */
export function mergeImportData(existing: unknown, incoming: ReturnType<typeof buildImportData>, batchId: string): ImportData | null {
  if (!incoming) return null;
  const base: ImportData = existing && typeof existing === "object" && !Array.isArray(existing) ? { ...(existing as ImportData) } : {};
  return { ...base, fields: { ...(base.fields ?? {}), ...incoming.fields }, extra: { ...(base.extra ?? {}), ...incoming.extra }, lastImportBatchId: batchId };
}

const leadNumberFor = (stamp: string, i: number) => `LEAD-${stamp}-${Math.random().toString(36).slice(2, 6).toUpperCase()}${i.toString(36).toUpperCase()}`;

async function sourceIds(names: Set<string>, cache: Map<string, string>): Promise<void> {
  for (const name of names) {
    if (cache.has(name)) continue;
    const code = name.toUpperCase().replace(/\s+/g, "_").slice(0, 50);
    const source = await prisma.source.upsert({ where: { code }, update: {}, create: { name: name.slice(0, 100), code } });
    cache.set(name, source.id);
  }
}

/** Processes one chunk inside the given transaction. Exported for tests. */
export async function processChunk(
  tx: Prisma.TransactionClient,
  ctx: BatchContext,
  rows: { id: number; rowNumber: number; data: Prisma.JsonValue }[],
  sources: Map<string, string>,
): Promise<{ created: number; updated: number; duplicates: number; failed: number; segmentAdded: number }> {
  const outcomes: RowOutcome[] = [];
  const importable: { row: (typeof rows)[number]; c: ParsedCustomer }[] = [];
  for (const row of rows) {
    const c = readCustomer(row.data as Record<string, string>, ctx.mapping);
    const problem = rowProblem(c);
    if (problem) outcomes.push({ id: row.id, status: "FAILED", reason: problem, leadId: null });
    else importable.push({ row, c });
  }

  const creates = importable.map(({ row, c }) => ({ leadId: randomUUID(), c, rowId: row.id, status: statusFromRow(row.data as Record<string, string>) }));
  const stamp = Date.now().toString(36).toUpperCase();

  await sourceIds(new Set([...creates.map((x) => x.c.sourceName?.trim() || DEFAULT_SOURCE)]), sources);

  // ---- new leads
  if (creates.length) {
    const isManager = ctx.uploaderRole === Role.MANAGER;
    await tx.lead.createMany({
      data: creates.map(({ leadId, c, status }, i) => {
        const count = c.orderCount.state === "ok" ? c.orderCount.value : null;
        return {
          id: leadId,
          leadNumber: leadNumberFor(stamp, i),
          firstName: c.firstName,
          lastName: c.lastName,
          mobile: c.mobile,
          normalizedMobile: c.normalizedMobile,
          email: c.email,
          normalizedEmail: c.normalizedEmail,
          location: c.location,
          requirement: c.requirement,
          sourceId: sources.get(c.sourceName?.trim() || DEFAULT_SOURCE),
          importBatchId: ctx.batchId,
          assignedManagerId: isManager ? ctx.uploaderId : undefined,
          orderCount: count,
          totalOrdersValue: c.totalOrdersValue,
          lastOrderAt: c.lastOrderAt,
          customerClass: classifyCustomer(count),
          // from the file's Tagging column only; blank or unrecognised leaves the database default (NEW)
          workingStatus: status ?? undefined,
          importData: (buildImportData(c) ?? undefined) as Prisma.InputJsonValue | undefined,
        };
      }),
    });
    await tx.activity.createMany({ data: creates.map(({ leadId }) => ({ leadId, type: ActivityType.LEAD_CREATED, referenceType: "LeadImportBatch", referenceId: ctx.batchId, title: "Lead created via file import" })) });
    if (isManager) {
      const now = new Date();
      await tx.leadAssignment.createMany({ data: creates.map(({ leadId }) => ({ id: randomUUID(), leadId, userId: ctx.uploaderId, assignmentType: AssignmentType.MANUAL, assignedById: ctx.uploaderId, assignedAt: now, isCurrent: true })) });
      await tx.activity.createMany({ data: creates.map(({ leadId }) => ({ leadId, actorId: ctx.uploaderId, type: ActivityType.ASSIGNMENT, referenceType: "LeadImportBatch", referenceId: ctx.batchId, title: "Auto-assigned to importing manager", description: "Method: FILE_IMPORT" })) });
    }
    for (const x of creates) outcomes.push({ id: x.rowId, status: "CREATED", reason: null, leadId: x.leadId });
  }

  // ---- campaign segment: every lead this import created joins it; other segments are never touched
  let segmentAdded = 0;
  if (ctx.segmentId) {
    const members = creates.map((x) => x.leadId);
    if (members.length) {
      const r = await tx.leadSegment.createMany({ data: members.map((leadId) => ({ leadId, segmentId: ctx.segmentId!, importBatchId: ctx.batchId, addedById: ctx.uploaderId })), skipDuplicates: true });
      segmentAdded = r.count;
    }
  }

  // ---- row outcomes and batch progress, in the same transaction
  if (outcomes.length) {
    await tx.$executeRaw`
      UPDATE lead_import_rows AS r
      SET status = v.status::import_row_status, reason = v.reason, lead_id = v.lead_id::uuid
      FROM unnest(${outcomes.map((o) => o.id)}::int[], ${outcomes.map((o) => o.status)}::text[], ${outcomes.map((o) => o.reason)}::text[], ${outcomes.map((o) => o.leadId)}::text[]) AS v(id, status, reason, lead_id)
      WHERE r.id = v.id`;
  }
  const count = (s: RowOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const result = { created: count("CREATED"), updated: count("UPDATED"), duplicates: count("DUPLICATE"), failed: count("FAILED"), segmentAdded };
  await tx.leadImportBatch.update({
    where: { id: ctx.batchId },
    data: { processedRows: { increment: rows.length }, createdRows: { increment: result.created }, updatedRows: { increment: result.updated }, duplicateRows: { increment: result.duplicates }, failedRows: { increment: result.failed }, segmentAdded: { increment: segmentAdded } },
  });
  return result;
}

const active = new Set<string>();
export const isImportRunning = (batchId: string): boolean => active.has(batchId);

/** Runs a batch to completion. Safe to call again for a batch that stopped part-way: only PENDING rows are processed. */
export async function runImport(batchId: string): Promise<void> {
  if (active.has(batchId)) return;
  active.add(batchId);
  try {
    const batch = await prisma.leadImportBatch.findUnique({ where: { id: batchId }, include: { uploadedBy: { select: { id: true, role: true } } } });
    if (!batch || batch.status !== ImportBatchStatus.PROCESSING) return;
    const stored = batch.columnMapping as { mapping?: ColumnMapping } | null;
    const ctx: BatchContext = { batchId, mapping: stored?.mapping ?? {}, segmentId: batch.segmentId, uploaderId: batch.uploadedBy.id, uploaderRole: batch.uploadedBy.role };
    const sources = new Map<string, string>();
    let consecutiveFailures = 0;
    for (;;) {
      const rows = await prisma.leadImportRow.findMany({ where: { batchId, status: "PENDING" }, orderBy: { id: "asc" }, take: CHUNK_SIZE, select: { id: true, rowNumber: true, data: true } });
      if (rows.length === 0) break;
      try {
        await prisma.$transaction((tx) => processChunk(tx, ctx, rows, sources), { timeout: 120_000, maxWait: 30_000 });
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        logger.error(`Lead import ${batchId}: chunk failed (${consecutiveFailures}) ${error instanceof Error ? error.name : "error"}`);
        if (consecutiveFailures >= 3) throw error;
        // a chunk that keeps failing is isolated row by row so one bad row cannot block the rest; whatever is left PENDING is retried by the loop
        if (consecutiveFailures === 2) {
          for (const row of rows) {
            try {
              await prisma.$transaction((tx) => processChunk(tx, ctx, [row], sources), { timeout: 60_000, maxWait: 30_000 });
            } catch (rowError) {
              await prisma.$transaction([
                prisma.leadImportRow.update({ where: { id: row.id }, data: { status: "FAILED", reason: `Could not be imported (${rowError instanceof Error ? rowError.name : "error"})` } }),
                prisma.leadImportBatch.update({ where: { id: batchId }, data: { processedRows: { increment: 1 }, failedRows: { increment: 1 } } }),
              ]);
            }
          }
          consecutiveFailures = 0;
        }
      }
    }
    await prisma.leadImportBatch.update({ where: { id: batchId }, data: { status: ImportBatchStatus.COMMITTED, committedAt: new Date(), finishedAt: new Date(), lastError: null } });
  } catch (error) {
    const message = (error instanceof Error ? `${error.name}: ${error.message}` : "Import stopped").slice(0, 400);
    logger.error(`Lead import ${batchId} stopped: ${message.slice(0, 120)}`);
    // remaining rows stay PENDING: starting the batch again resumes it
    await prisma.leadImportBatch.update({ where: { id: batchId }, data: { status: ImportBatchStatus.FAILED, finishedAt: new Date(), lastError: "The import stopped before it finished. Start it again to continue from where it stopped." } }).catch(() => undefined);
  } finally {
    active.delete(batchId);
  }
}

/** Starts a batch in the background (the HTTP request returns immediately). */
export function enqueueImport(batchId: string): void {
  void runImport(batchId);
}

/** After a restart: batches left PROCESSING continue from their remaining rows. */
export async function resumeInterruptedImports(): Promise<number> {
  const stuck = await prisma.leadImportBatch.findMany({ where: { status: ImportBatchStatus.PROCESSING }, select: { id: true } });
  for (const b of stuck) enqueueImport(b.id);
  return stuck.length;
}
