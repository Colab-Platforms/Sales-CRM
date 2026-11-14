import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { logger } from "@/utils/logger.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { Prisma } from "../../../generated/prisma/client.js";
import { ActivitySource } from "../../../generated/prisma/enums.js";
import { safeMessage } from "../integrations/integrations.common.js";
import { SAVE_TX_OPTIONS, saveAbandonment } from "../shiprocket/shiprocket.abandonment.processor.js";
import { fetchAbandonedCarts, FastrrRecoveryError, validateRange, type FetchCartsOptions } from "./fastrr-recovery.client.js";
import { FastrrRecoveryConfigError, loadFastrrRecoveryConfig, type FastrrRecoveryConfig } from "./fastrr-recovery.config.js";
import { mapFastrrCart, type RecoveryCart } from "./fastrr-recovery.mapper.js";

// Recovery of abandoned carts the CRM never received (e.g. webhooks lost while the server was suspended), read from Fastrr's own abandoned-cart report.
//
// Flow: PREVIEW (read-only: fetch, classify, count) -> an authorised user CONFIRMS -> the import re-reads Fastrr, re-checks the CRM, and saves only what is still missing through the SAME
// save step the live webhook uses (saveAbandonment), so a recovered cart is an ordinary abandoned lead. It never auto-assigns, never edits an existing lead's name/phone/email/status/
// owner, and a repeated run finds nothing left to import. The Fastrr credentials are read from the environment inside this module only.

export type CartStatus = "MISSING" | "EXISTING" | "DUPLICATE" | "INVALID" | "CONVERTED";

export interface ClassifiedCart {
  status: CartStatus;
  reason: string | null;
  /** For EXISTING: where the CRM already has this cart. */
  existingIn: "ABANDONMENT" | "WEBHOOK" | null;
  cart: RecoveryCart;
}

export interface PreviewCounts {
  fetched: number;
  existing: number;
  missing: number;
  duplicates: number;
  invalid: number;
  converted: number;
}

export interface Analysis {
  from: string;
  to: string;
  includeConverted: boolean;
  classified: ClassifiedCart[];
  counts: PreviewCounts;
  pages: number;
  complete: boolean;
  stoppedBecause: string;
  reportedTotal: number | null;
}

export interface RunError {
  cartId: string;
  reason: string;
}

type Db = typeof prisma;

export interface FastrrRecoveryDeps {
  db?: Db;
  config?: () => FastrrRecoveryConfig;
  fetchOptions?: FetchCartsOptions;
  now?: () => Date;
  concurrency?: number;
}

export const MAX_RUN_ERRORS = 200;
const EXISTING_QUERY_CHUNK = 1000;
const STALE_RUN_MS = 10 * 60_000;
const PROGRESS_EVERY = 10;
const SAMPLE_SIZE = 25;
const RECOVERY_LOCK = "fastrr-recovery-run";

export const maskPhone = (phone: string | null): string => {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 7 ? `${digits.slice(0, 2)}******${digits.slice(-2)}` : digits ? "******" : "";
};

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof FastrrRecoveryConfigError) return new ApiError(error.message, STATUS_CODES.SERVICE_UNAVAILABLE);
  if (error instanceof FastrrRecoveryError) {
    if (error.code === "BAD_REQUEST" && error.httpStatus === null) return new ApiError(error.message, STATUS_CODES.BAD_REQUEST);
    if (error.code === "AUTH") return new ApiError("Fastrr rejected the saved credentials. Refresh FASTRR_REPORTING_AUTH_TOKEN / FASTRR_REPORTING_AUTH_INFO and try again.", 502);
    if (error.code === "RATE_LIMIT") return new ApiError("Fastrr is rate limiting requests. Try again in a few minutes.", 503);
    if (error.code === "TIMEOUT") return new ApiError("Fastrr did not respond in time. Try again.", 504);
    if (error.code === "MALFORMED") return new ApiError("Fastrr returned a response the CRM could not read. Nothing was imported.", 502);
    return new ApiError("Could not load abandoned carts from Fastrr. Try again.", 502);
  }
  return new ApiError("Could not load abandoned carts from Fastrr.", 502);
}

const istText = (d: Date | null): string => (d ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 16).replace("T", " ") : "");

async function inPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]!);
  });
  await Promise.all(workers);
}

export class FastrrRecoveryService {
  private readonly db: Db;
  private readonly loadConfig: () => FastrrRecoveryConfig;
  private readonly fetchOptions: FetchCartsOptions;
  private readonly now: () => Date;
  private readonly concurrency: number;

  constructor(deps: FastrrRecoveryDeps = {}) {
    this.db = deps.db ?? prisma;
    this.loadConfig = deps.config ?? (() => loadFastrrRecoveryConfig());
    this.fetchOptions = deps.fetchOptions ?? {};
    this.now = deps.now ?? (() => new Date());
    this.concurrency = deps.concurrency ?? 3;
  }

  /** Which of these Fastrr cart ids does the CRM already hold? An abandonment with this reference (any status, any lead) or a stored Fastrr webhook delivery for it (anything but IGNORED). */
  async findExisting(cartIds: string[]): Promise<Map<string, "ABANDONMENT" | "WEBHOOK">> {
    const found = new Map<string, "ABANDONMENT" | "WEBHOOK">();
    for (let i = 0; i < cartIds.length; i += EXISTING_QUERY_CHUNK) {
      const chunk = cartIds.slice(i, i + EXISTING_QUERY_CHUNK);
      const rows = await this.db.abandonment.findMany({ where: { referenceId: { in: chunk } }, select: { referenceId: true } });
      for (const r of rows) if (r.referenceId) found.set(r.referenceId, "ABANDONMENT");
      const events = await this.db.$queryRaw<{ cart_id: string }[]>(Prisma.sql`
        SELECT DISTINCT payload->>'cart_id' AS cart_id FROM webhook_events
        WHERE provider = 'SHIPROCKET_CHECKOUT' AND status::text <> 'IGNORED' AND payload->>'cart_id' IN (${Prisma.join(chunk)})`);
      for (const e of events) if (e.cart_id && !found.has(e.cart_id)) found.set(e.cart_id, "WEBHOOK");
    }
    return found;
  }

  /** Reads Fastrr (read-only) and classifies every record against the CRM. Writes nothing. */
  async analyze(from: string, to: string, options: { includeConverted?: boolean } = {}): Promise<Analysis> {
    const problem = validateRange(from, to);
    if (problem) throw new ApiError(problem, STATUS_CODES.BAD_REQUEST);
    const includeConverted = options.includeConverted === true;
    let fetched;
    try {
      fetched = await fetchAbandonedCarts(this.loadConfig(), from, to, this.fetchOptions);
    } catch (error) {
      throw toApiError(error);
    }

    const mapped = fetched.records.map((raw) => mapFastrrCart(raw));
    const classified: ClassifiedCart[] = [];

    // One entry per Fastrr cart id: a usable record beats an unusable one, then the latest checkout time wins; every other record of the same id is a duplicate.
    const groups = new Map<string, RecoveryCart[]>();
    for (const cart of mapped) {
      if (!cart.cartId) {
        classified.push({ status: "INVALID", reason: cart.invalidReason ?? "Missing cart id", existingIn: null, cart });
        continue;
      }
      const list = groups.get(cart.cartId) ?? [];
      list.push(cart);
      groups.set(cart.cartId, list);
    }
    const chosen: RecoveryCart[] = [];
    for (const list of groups.values()) {
      const ranked = [...list].sort((a, b) => Number(Boolean(b.parsed)) - Number(Boolean(a.parsed)) || (b.abandonedAt?.getTime() ?? 0) - (a.abandonedAt?.getTime() ?? 0));
      chosen.push(ranked[0]!);
      for (const dup of ranked.slice(1)) classified.push({ status: "DUPLICATE", reason: "Listed more than once by Fastrr", existingIn: null, cart: dup });
    }

    const existing = await this.findExisting(chosen.filter((c) => c.parsed).map((c) => c.cartId!));
    for (const cart of chosen) {
      if (!cart.parsed) classified.push({ status: "INVALID", reason: cart.invalidReason, existingIn: null, cart });
      else if (existing.has(cart.cartId!)) classified.push({ status: "EXISTING", reason: null, existingIn: existing.get(cart.cartId!)!, cart });
      else if (cart.orderId && !includeConverted) classified.push({ status: "CONVERTED", reason: "Customer completed this checkout as an order", existingIn: null, cart });
      else classified.push({ status: "MISSING", reason: null, existingIn: null, cart });
    }

    const count = (s: CartStatus) => classified.filter((c) => c.status === s).length;
    return {
      from,
      to,
      includeConverted,
      classified,
      counts: { fetched: fetched.records.length, existing: count("EXISTING"), missing: count("MISSING"), duplicates: count("DUPLICATE"), invalid: count("INVALID"), converted: count("CONVERTED") },
      pages: fetched.pages,
      complete: fetched.complete,
      stoppedBecause: fetched.stoppedBecause,
      reportedTotal: fetched.reportedTotal,
    };
  }

  /** The read-only recovery preview. */
  async preview(from: string, to: string, options: { includeConverted?: boolean } = {}) {
    const a = await this.analyze(from, to, options);
    const warnings: string[] = [];
    if (!a.complete) warnings.push("Fastrr returned more pages than the safety limit - this list is incomplete and cannot be imported. Choose a shorter date range.");
    if (a.reportedTotal !== null && a.reportedTotal !== a.counts.fetched) warnings.push(`Fastrr reports ${a.reportedTotal} carts but ${a.counts.fetched} were read.`);
    if (a.counts.fetched === 0) warnings.push("Fastrr returned no abandoned carts for this range.");
    const sample = (status: CartStatus) => a.classified.filter((c) => c.status === status).slice(0, SAMPLE_SIZE);
    return {
      from: a.from,
      to: a.to,
      includeConverted: a.includeConverted,
      counts: a.counts,
      pages: a.pages,
      complete: a.complete,
      stoppedBecause: a.stoppedBecause,
      reportedTotal: a.reportedTotal,
      warnings,
      sampleMissing: sample("MISSING").map((c) => ({ cartId: c.cart.cartId, customerName: c.cart.customerName, phone: maskPhone(c.cart.phone), items: c.cart.itemsText, cartValue: c.cart.cartValue, abandonedAt: c.cart.abandonedAt?.toISOString() ?? null, hasAddress: Boolean(c.cart.address.full) })),
      sampleInvalid: sample("INVALID").map((c) => ({ cartId: c.cart.cartId, reason: c.reason })),
    };
  }

  /** Starts a confirmed import and returns at once with the run row; `done` settles when every cart has been handled (the HTTP layer does not wait for it). */
  async startImport(user: Pick<AuthUser, "id">, input: { from: string; to: string; includeConverted?: boolean; expectedMissing?: number; retryOfId?: string }): Promise<{ run: Awaited<ReturnType<FastrrRecoveryService["getRun"]>>; done: Promise<void> }> {
    const a = await this.analyze(input.from, input.to, { includeConverted: input.includeConverted });
    if (!a.complete) throw new ApiError("Fastrr's list is incomplete (page limit reached). Choose a shorter date range.", STATUS_CODES.CONFLICT);
    if (input.expectedMissing !== undefined && input.expectedMissing !== a.counts.missing) {
      throw new ApiError(`The data changed since the preview: ${a.counts.missing} carts are missing now, the preview showed ${input.expectedMissing}. Preview again.`, STATUS_CODES.CONFLICT);
    }
    const toImport = a.classified.filter((c) => c.status === "MISSING");

    // One run at a time (a double click or two admins must not import the same carts twice). The check and the insert share one advisory-locked transaction.
    const runId = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECOVERY_LOCK}))`;
      const cutoff = new Date(this.now().getTime() - STALE_RUN_MS);
      await tx.fastrrRecoveryRun.updateMany({ where: { status: "RUNNING", updatedAt: { lt: cutoff } }, data: { status: "FAILED", finishedAt: this.now(), errors: [{ cartId: "-", reason: "Interrupted - the server stopped before this import finished. Retry it." }] } });
      const active = await tx.fastrrRecoveryRun.findFirst({ where: { status: "RUNNING" }, select: { id: true } });
      if (active) throw new ApiError("Another Fastrr recovery import is still running. Wait for it to finish.", STATUS_CODES.CONFLICT);
      const created = await tx.fastrrRecoveryRun.create({
        data: {
          createdById: user.id,
          fromDay: a.from,
          toDay: a.to,
          includeConverted: a.includeConverted,
          retryOfId: input.retryOfId ?? null,
          status: toImport.length === 0 ? "COMPLETED" : "RUNNING",
          finishedAt: toImport.length === 0 ? this.now() : null,
          ...a.counts,
        },
        select: { id: true },
      });
      return created.id;
    });

    const run = await this.getRun(runId);
    const done = toImport.length === 0 ? Promise.resolve() : this.processRun(runId, toImport).catch((error) => logger.error(`fastrr.recovery run=${runId} crashed reason=${safeMessage(error instanceof Error ? error.message : String(error))}`));
    return { run, done };
  }

  /** Imports the carts, each in its own transaction, so one bad cart fails alone. */
  private async processRun(runId: string, carts: ClassifiedCart[]): Promise<void> {
    let imported = 0;
    let merged = 0;
    let skippedExisting = 0;
    const errors: RunError[] = [];
    let failed = 0;
    let handled = 0;

    const flush = (finish: boolean) =>
      this.db.fastrrRecoveryRun.update({
        where: { id: runId },
        data: {
          imported,
          merged,
          skippedExisting,
          failed,
          errors: errors.slice(0, MAX_RUN_ERRORS) as unknown as Prisma.InputJsonValue,
          ...(finish ? { finishedAt: this.now(), status: failed === 0 ? "COMPLETED" : imported + merged + skippedExisting > 0 ? "PARTIAL" : "FAILED" } : {}),
        },
      });

    await inPool(carts, this.concurrency, async ({ cart }) => {
      try {
        const outcome = await this.db.$transaction(async (tx) => {
          // Re-checked inside the transaction: a webhook delivery may have saved this cart since the preview.
          const already = await tx.abandonment.findFirst({ where: { referenceId: cart.cartId! }, select: { id: true } });
          if (already) return "SKIPPED" as const;
          const saved = await saveAbandonment(tx, cart.parsed!, this.now(), {
            referenceType: "FastrrRecoveryCart",
            activitySource: ActivitySource.SYSTEM,
            createdTitle: "Checkout recovered from Fastrr",
            updatedTitle: "Checkout recovered from Fastrr (matched an existing checkout)",
            keepNewerLastActivity: true,
          });
          return saved.created ? ("CREATED" as const) : ("MERGED" as const);
        }, SAVE_TX_OPTIONS);
        if (outcome === "CREATED") imported++;
        else if (outcome === "MERGED") merged++;
        else skippedExisting++;
      } catch (error) {
        failed++;
        errors.push({ cartId: cart.cartId!, reason: safeMessage(error instanceof Error ? error.message : String(error), "Could not save this cart").slice(0, 200) });
      }
      handled++;
      if (handled % PROGRESS_EVERY === 0) await flush(false).catch(() => undefined);
    });
    await flush(true);
    logger.info(`fastrr.recovery run=${runId} imported=${imported} merged=${merged} skipped=${skippedExisting} failed=${failed}`);
  }

  /** Re-runs a PARTIAL / FAILED (or interrupted) import: it re-reads Fastrr and imports whatever is still missing - carts already saved are found and left alone. */
  async retryRun(user: Pick<AuthUser, "id">, runId: string) {
    const previous = await this.db.fastrrRecoveryRun.findUnique({ where: { id: runId } });
    if (!previous) throw new ApiError("Import run not found", STATUS_CODES.NOT_FOUND);
    const interrupted = previous.status === "RUNNING" && previous.updatedAt.getTime() < this.now().getTime() - STALE_RUN_MS;
    if (previous.status !== "PARTIAL" && previous.status !== "FAILED" && !interrupted) throw new ApiError("Only a failed or partly failed import can be retried.", STATUS_CODES.CONFLICT);
    return this.startImport(user, { from: previous.fromDay, to: previous.toDay, includeConverted: previous.includeConverted, retryOfId: previous.id });
  }

  async getRun(id: string) {
    const run = await this.db.fastrrRecoveryRun.findUnique({ where: { id } });
    if (!run) throw new ApiError("Import run not found", STATUS_CODES.NOT_FOUND);
    return run;
  }

  async listRuns(limit = 20) {
    return this.db.fastrrRecoveryRun.findMany({ orderBy: { startedAt: "desc" }, take: Math.min(Math.max(limit, 1), 100) });
  }

  /** The recovery Excel: every Fastrr record of the range with its status and the full set of customer + address columns. Read-only. */
  async exportWorkbook(from: string, to: string, options: { includeConverted?: boolean } = {}): Promise<{ buffer: Buffer; fileName: string; rows: number }> {
    const a = await this.analyze(from, to, options);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Fastrr abandoned carts", { views: [{ state: "frozen", ySplit: 1 }] });
    const columns: { header: string; key: string; width: number }[] = [
      { header: "Cart ID", key: "cartId", width: 26 },
      { header: "CRM status", key: "status", width: 14 },
      { header: "Note", key: "reason", width: 34 },
      { header: "Customer Name", key: "name", width: 24 },
      { header: "Phone Number", key: "phone", width: 16 },
      { header: "Email", key: "email", width: 28 },
      { header: "Address Line 1", key: "line1", width: 30 },
      { header: "Address Line 2", key: "line2", width: 24 },
      { header: "Landmark", key: "landmark", width: 20 },
      { header: "City", key: "city", width: 16 },
      { header: "State", key: "state", width: 16 },
      { header: "Pincode", key: "pincode", width: 10 },
      { header: "Country", key: "country", width: 12 },
      { header: "Full Shipping Address", key: "full", width: 50 },
      { header: "Items", key: "items", width: 44 },
      { header: "Cart value", key: "value", width: 12 },
      { header: "Checkout time (IST)", key: "time", width: 18 },
      { header: "Checkout stage", key: "stage", width: 18 },
      { header: "Coupon discount", key: "coupon", width: 14 },
      { header: "Fastrr order ID", key: "orderId", width: 18 },
    ];
    sheet.columns = columns;
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
    const label: Record<CartStatus, string> = { MISSING: "Missing", EXISTING: "Already in CRM", DUPLICATE: "Duplicate", INVALID: "Invalid", CONVERTED: "Ordered" };
    for (const c of a.classified) {
      const { cart } = c;
      sheet.addRow({
        cartId: cart.cartId ?? "",
        status: label[c.status],
        reason: c.reason ?? (c.existingIn === "WEBHOOK" ? "Received by webhook" : ""),
        name: cart.customerName,
        phone: cart.phone ?? "",
        email: cart.email ?? "",
        line1: cart.address.line1,
        line2: cart.address.line2,
        landmark: cart.address.landmark,
        city: cart.address.city,
        state: cart.address.state,
        pincode: cart.address.pincode,
        country: cart.address.country,
        full: cart.address.full,
        items: cart.itemsText,
        value: cart.cartValue,
        time: istText(cart.abandonedAt),
        stage: cart.stage ?? "",
        coupon: cart.couponDiscount,
        orderId: cart.orderId ?? "",
      });
    }
    sheet.getColumn("value").numFmt = "#,##0.00";
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    return { buffer, fileName: `fastrr-abandoned-carts_${from}_to_${to}.xlsx`, rows: a.classified.length };
  }

  isConfigured(): boolean {
    try {
      this.loadConfig();
      return true;
    } catch {
      return false;
    }
  }
}
