import { Prisma } from "../../../generated/prisma/client.js";
import { CallDirection } from "../../../generated/prisma/enums.js";
import type { prisma as PrismaSingleton } from "@/lib/prisma.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { abandonmentLeadScope, classifyCallStatus } from "./abandonment.filters.js";
import { readSnapshotItems } from "./abandonment.items.js";
import AbandonmentService from "./abandonment.service.js";
import { recordingRangeBounds, unavailableReason, recordingExtension, recordingFileName, type AbandonmentRecordingsService, type RecordingRange } from "./abandonment.recordings.js";
import { validateListAbandonmentsQuery } from "./abandonment.validators.js";
import { uniqueName } from "./recording-export.core.js";
import type { ExcelRow, ExcelSource } from "./recording-export.excel.js";

type Db = typeof PrismaSingleton;

// The database-facing halves of the two export kinds: the chunked planner of the recording ZIP and the paged reader of the Excel export. Both read in bounded keyset pages.

export const PAGE_ROWS = 1000;

/** The list filters an Excel export may carry (the same names and validation as the Abandoned Leads list). Anything else is dropped. */
const FILTER_KEYS = ["search", "status", "type", "assignment", "managerId", "salespersonId", "workingStatus", "lead", "contact", "assignee", "lastAction", "valueMin", "valueMax", "items", "dateRange", "dateFrom", "dateTo", "bucket"] as const;

/** The most leads an explicit selection (ticked rows) can carry; a bigger selection is made with "select all matching", which sends the filters instead. */
export const MAX_SELECTED_LEADS = 2000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StoredExportFilters = Record<string, unknown> & { ids?: string[]; matching?: true };

/**
 * What an Excel export is restricted to, besides the date range:
 *  - ids: exactly these abandoned leads (the ones ticked in the list) - nothing else is ever exported;
 *  - matching: "select all matching" - every lead the list filters, search and day range match, whatever the page;
 *  - otherwise the list filters on top of the panel date range.
 * Every value is validated with the list's own schema, so a bad one is a clear 400 now, not a failed job later.
 */
export function sanitizeExportFilters(raw: unknown): StoredExportFilters | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const flat: Record<string, string> = {};
  for (const key of FILTER_KEYS) {
    const v = input[key];
    if ((typeof v === "string" || typeof v === "number") && String(v) !== "") flat[key] = String(v).slice(0, 4000);
  }
  const out: StoredExportFilters = { ...flat };
  if (input.ids !== undefined) {
    if (!Array.isArray(input.ids) || input.ids.some((id) => typeof id !== "string" || !UUID.test(id))) throw new ApiError("The selected leads are not valid", STATUS_CODES.BAD_REQUEST);
    const ids = [...new Set(input.ids as string[])].sort();
    if (ids.length === 0) throw new ApiError("No leads selected", STATUS_CODES.BAD_REQUEST);
    if (ids.length > MAX_SELECTED_LEADS) throw new ApiError(ids.length + " leads selected - at most " + MAX_SELECTED_LEADS + " can be exported by selection. Use Select all matching instead.", STATUS_CODES.BAD_REQUEST);
    out.ids = ids;
  } else if (input.matching === true) out.matching = true;
  if (Object.keys(out).length === 0) return null;
  const parsed = validateListAbandonmentsQuery({ page: "1", pageSize: "1", ...flat });
  if (parsed.error) throw new ApiError(parsed.error.message, STATUS_CODES.BAD_REQUEST);
  return out;
}

/** How a job's stored filters read back, for the status shown to the user. */
export function describeSelection(filters: unknown): { selection: "IDS" | "MATCHING" | null; selectedCount: number | null; filtered: boolean } {
  const f = (filters && typeof filters === "object" ? filters : {}) as Record<string, unknown>;
  const filtered = Object.keys(f).some((k) => k !== "ids" && k !== "matching");
  if (Array.isArray(f.ids)) return { selection: "IDS", selectedCount: f.ids.length, filtered: false };
  if (f.matching === true) return { selection: "MATCHING", selectedCount: null, filtered };
  return { selection: null, selectedCount: null, filtered };
}

const SUCCESSFUL_CALL = new Set(["successful"]);

function itemsText(snapshot: unknown): { text: string; value: number | null; currency: string | null } {
  const s = (snapshot && typeof snapshot === "object" ? snapshot : {}) as Record<string, unknown>;
  const lines = readSnapshotItems(s.items);
  const names = Array.isArray(s.itemNames) ? s.itemNames.filter((n): n is string => typeof n === "string") : [];
  const text = lines.length > 0 ? lines.map((i) => (i.quantity && i.quantity > 1 ? `${i.name} x ${i.quantity}` : i.name)).join(", ") : names.join(", ");
  const value = typeof s.cartValue === "string" && /^[0-9]+([.][0-9]+)?$/.test(s.cartValue) ? Number(s.cartValue) : null;
  return { text, value, currency: typeof s.currency === "string" ? s.currency : null };
}

const titleCase = (status: string) => status.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Abandoned leads of one date range (and filters), newest first, read in keyset pages and enriched per page - never as one big result. */
export class PrismaExcelSource implements ExcelSource {
  private readonly service: AbandonmentService;
  constructor(
    private readonly db: Db,
    private readonly user: AuthUser,
    private readonly range: RecordingRange,
    private readonly filters: StoredExportFilters | null,
    private readonly pageRows: number = PAGE_ROWS,
  ) {
    this.service = new AbandonmentService(db as never, undefined, null);
  }

  private async where(): Promise<Prisma.AbandonmentWhereInput> {
    const scope = abandonmentLeadScope(this.user);
    const { ids, matching, ...rest } = (this.filters ?? {}) as { ids?: string[]; matching?: true } & Record<string, string>;
    // Exactly the ticked leads (inside what this user may see) and nothing else - no filter or date can widen it.
    if (ids) return { AND: [{ id: { in: ids } }, ...(Object.keys(scope).length > 0 ? [{ lead: scope }] : [])] };
    const parsed = validateListAbandonmentsQuery({ page: "1", pageSize: "1", ...rest });
    if (parsed.error) throw new ApiError(parsed.error.message, STATUS_CODES.BAD_REQUEST);
    // "Select all matching": the list's own day tab / dates and filters, exactly as the list applied them.
    if (matching) return this.service.listWhere(parsed.value!, scope, this.user.role);
    // The panel's chosen days replace the list's own day tabs: detected within [gte, lt).
    const { gte, lt } = recordingRangeBounds(this.range);
    const query = { ...parsed.value!, dateRange: "all" as const, dateFrom: gte, dateTo: new Date(lt.getTime() - 1) };
    return this.service.listWhere(query, scope, this.user.role);
  }

  async count(): Promise<number> {
    return this.db.abandonment.count({ where: await this.where() });
  }

  async *pages(): AsyncGenerator<ExcelRow[]> {
    const where = await this.where();
    let cursor: { detectedAt: Date; id: string } | null = null;
    for (;;) {
      const rows: Awaited<ReturnType<typeof this.readPage>> = await this.readPage(where, cursor);
      if (rows.length === 0) return;
      const last = rows[rows.length - 1]!;
      cursor = { detectedAt: last.detectedAt, id: last.id };
      yield await this.enrich(rows);
      if (rows.length < this.pageRows) return;
    }
  }

  private readPage(where: Prisma.AbandonmentWhereInput, cursor: { detectedAt: Date; id: string } | null) {
    // Keyset (detected_at DESC, id ASC): stable under inserts, no OFFSET, uses the detected_at index.
    const after: Prisma.AbandonmentWhereInput | null = cursor ? { OR: [{ detectedAt: { lt: cursor.detectedAt } }, { detectedAt: cursor.detectedAt, id: { gt: cursor.id } }] } : null;
    return this.db.abandonment.findMany({
      where: after ? { AND: [where, after] } : where,
      orderBy: [{ detectedAt: "desc" }, { id: "asc" }],
      take: this.pageRows,
      select: {
        id: true,
        detectedAt: true,
        referenceId: true,
        cartSnapshot: true,
        lead: { select: { id: true, leadNumber: true, firstName: true, lastName: true, mobile: true, email: true, workingStatus: true, owner: { select: { name: true } }, assignedManager: { select: { name: true } } } },
      },
    });
  }

  private async enrich(rows: Awaited<ReturnType<typeof this.readPage>>): Promise<ExcelRow[]> {
    const leadIds = [...new Set(rows.map((r) => r.lead.id))];
    const ids = Prisma.join(leadIds.map((id) => Prisma.sql`${id}::uuid`));
    // Calls and recordings of this page's leads in one grouped query each.
    const calls = await this.db.$queryRaw<{ lead_id: string; status: string; direction: string; n: bigint; recs: bigint }[]>(Prisma.sql`
      SELECT c.lead_id, c.status::text AS status, c.direction::text AS direction, count(*) AS n, count(r.id) FILTER (WHERE r.recording_url IS NOT NULL AND btrim(r.recording_url) <> '') AS recs
      FROM calls c LEFT JOIN call_recordings r ON r.call_id = c.id
      WHERE c.lead_id IN (${ids}) GROUP BY c.lead_id, c.status, c.direction`);
    const stats = new Map<string, { attempts: number; ok: number; recs: number }>();
    for (const c of calls) {
      const s = stats.get(c.lead_id) ?? { attempts: 0, ok: 0, recs: 0 };
      s.recs += Number(c.recs);
      if (c.direction === CallDirection.OUTBOUND) {
        s.attempts += Number(c.n);
        if (SUCCESSFUL_CALL.has(classifyCallStatus(c.status))) s.ok += Number(c.n);
      }
      stats.set(c.lead_id, s);
    }
    const orders = await this.db.order.findMany({ where: { leadId: { in: leadIds } }, orderBy: { createdAt: "desc" }, select: { leadId: true, orderNumber: true, externalNumber: true } });
    const orderInfo = new Map<string, { count: number; latest: string }>();
    for (const o of orders) {
      const e = orderInfo.get(o.leadId);
      if (e) e.count++;
      else orderInfo.set(o.leadId, { count: 1, latest: o.externalNumber ?? o.orderNumber });
    }
    return rows.map((r) => {
      const cart = itemsText(r.cartSnapshot);
      const s = stats.get(r.lead.id) ?? { attempts: 0, ok: 0, recs: 0 };
      const o = orderInfo.get(r.lead.id);
      return {
        leadNumber: r.lead.leadNumber,
        customerName: [r.lead.firstName, r.lead.lastName].filter(Boolean).join(" "),
        mobile: r.lead.mobile,
        email: r.lead.email,
        items: cart.text,
        orderValue: cart.value,
        currency: cart.currency,
        detectedAt: r.detectedAt,
        leadStatus: titleCase(r.lead.workingStatus),
        callAttempts: s.attempts,
        successfulCalls: s.ok,
        assignedTo: r.lead.owner?.name ?? (r.lead.assignedManager ? "No telecaller yet" : "Unassigned"),
        manager: r.lead.assignedManager?.name ?? "",
        recordingAvailable: s.recs > 0,
        recordingCount: s.recs,
        checkoutReference: r.referenceId,
        customerOrders: o?.count ?? 0,
        latestOrder: o?.latest ?? null,
      };
    });
  }
}

export interface PlannedZip {
  total: number;
  failed: number;
  duplicates: number;
}

/**
 * Writes the ZIP's item rows for one date range in bounded keyset pages (PAGE_ROWS calls at a time), de-duplicating by recording link as it goes, so a year of data is planned
 * incrementally without ever holding the whole range. Throws when the range holds more than `maxItems`. The caller owns the job row (and deletes it if this throws).
 */
export async function planZipItems(args: {
  db: Db;
  recordings: AbandonmentRecordingsService;
  user: AuthUser;
  range: RecordingRange;
  jobId: string;
  now: Date;
  maxItems: number;
  pageRows?: number;
}): Promise<PlannedZip> {
  const { db, recordings, user, range, jobId, now, maxItems } = args;
  const take = args.pageRows ?? PAGE_ROWS;
  const where = recordings.rangeWhere(range);
  const seenLinks = new Set<string>();
  const names = new Set<string>(["_summary.txt"]);
  let seq = 0;
  let failed = 0;
  let duplicates = 0;
  let afterId: string | undefined;
  for (;;) {
    const rows = await recordings.rowsFor(user, where, { afterId, take });
    if (rows.length === 0) break;
    afterId = rows[rows.length - 1]!.callId;
    const batch: { jobId: string; seq: number; callId: string; fileName: string; status: string; reason: string | null }[] = [];
    for (const r of rows) {
      const reason = unavailableReason(r, now);
      if (reason) failed++;
      else {
        const link = r.recordingUrl!.trim();
        if (seenLinks.has(link)) {
          duplicates++;
          continue;
        }
        seenLinks.add(link);
      }
      if (seq >= maxItems) throw new ApiError(`More than ${maxItems} recordings match. Choose a shorter date range.`, STATUS_CODES.BAD_REQUEST);
      batch.push({ jobId, seq: seq++, callId: r.callId, fileName: uniqueName(recordingFileName({ leadNumber: r.leadNumber, customerName: r.customerName, at: r.at, callId: r.callId, extension: recordingExtension(r.recordingUrl ?? "") }), names), status: reason ? "FAILED" : "PENDING", reason });
    }
    if (batch.length > 0) await db.recordingExportItem.createMany({ data: batch });
    if (rows.length < take) break;
  }
  return { total: seq, failed, duplicates };
}
