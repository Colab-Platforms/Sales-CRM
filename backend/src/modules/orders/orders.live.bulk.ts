// Order COUNT and Excel DOWNLOAD for the Orders list (ADMIN / MANAGER). Read-only: Shopify queries and CRM SELECTs; nothing is written anywhere.
//
// The list is read live from Shopify one page at a time, and most column filters (status, payment, source, salesperson, fulfilment, total...) can only be
// evaluated AFTER the CRM details are joined on. So:
//   - only date range / search filters -> Shopify's own `ordersCount` answers the count in one cheap request;
//   - anything else, and every filtered download -> every order Shopify matches is read, joined to the CRM and filtered by the SAME functions the list uses
//     (shopifySearch, overlayRows, applyOrderFilters), so the count, the file and the list cannot disagree.
// Reading thousands of orders takes far longer than one request should, so the read runs once in the background; a request waits a short while and otherwise
// answers "pending" with the progress, and the browser asks again. The finished read is kept briefly: changing a CRM-side filter, or downloading what was
// just counted, does not ask Shopify again. It lives in this process only and is never stored.
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma.js";
import type { DbClient } from "@/lib/leadScope.js";
import type { AuthUser } from "@/middlewares/auth.js";
import { ApiError } from "@/utils/apiError.js";
import STATUS_CODES from "@/utils/statusCodes.js";
import { Role } from "../../../generated/prisma/enums.js";
import { ShopifyApiError, ShopifyClient } from "../shopify/shopify.client.js";
import { loadShopifyConfig } from "../shopify/shopify.config.js";
import { countRecords, listOrdersForDisplay, type LiveOrdersPage, type NormalizedOrderListItem } from "../shopify/shopify.orders.js";
import { normalizeShopifyOrderId } from "../shopify/shopify.money.js";
import { safeCell } from "../report-automation/report-automation.xlsx.js";
import { BUSINESS_TIMEZONE } from "./orders.dashboard.range.js";
import OrdersLiveService, { applyOrderFilters, hasOverlayFilters, onClearLiveOrderCaches } from "./orders.live.service.js";
import { LIVE_ORDER_ID_PREFIX, type LiveOrderListItem, type LiveOrdersQuery } from "./orders.live.types.js";

export const ORDER_BULK_ROLES: Role[] = [Role.ADMIN, Role.MANAGER];
/** More orders than this are refused with an explanation (the same limit as the dashboard export): a count or file is never silently cut short. */
export const MAX_BULK_ORDERS = 20_000;
export const MAX_SELECTED_ORDERS = 1_000;
const PAGE_SIZE = 100;
/** How long one request waits for a running read before answering "pending". */
const WAIT_MS = 10_000;
const RESULT_TTL_MS = 60_000;
const FAILURE_TTL_MS = 30_000;
const MAX_RUNNING_SCANS = 3;
const THROTTLE_RETRIES = 5;
const THROTTLE_WAIT_MS = 5_000;

export type BulkFilters = Omit<LiveOrdersQuery, "after" | "first">;
type Row = Awaited<ReturnType<OrdersLiveService["overlayRows"]>>[number];
export type Pending = { status: "pending"; checked: number; expected: number | null };
export type CountResult = Pending | { status: "ready"; total: number };
export interface OrdersFile {
  buffer: Buffer;
  filename: string;
  rows: number;
  /** Selected orders that could not be found (selected download only). */
  missing: number;
}
export type ExportResult = Pending | ({ status: "ready" } & OrdersFile);

interface Scan {
  checked: number;
  expected: number | null;
  done: Promise<void>;
  result?: { rows: Row[]; readAt: Date };
  error?: unknown;
  expiresAt: number;
}

const toList = <T,>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function shopifyFailure(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(error instanceof ShopifyApiError ? error.message : "Could not reach Shopify - please try again.", 502);
}

const isThrottle = (e: unknown) => e instanceof ShopifyApiError && (e.status === 429 || /throttl|rate limit/i.test(e.message));

const tooLarge = (count?: number) =>
  new ApiError(
    `${count ? `${count.toLocaleString("en-IN")} orders match the date range and search` : "These filters cover too many orders"}; at most ${MAX_BULK_ORDERS.toLocaleString("en-IN")} can be counted or downloaded at once. Choose a shorter date range.`,
    422,
  );

export interface OrdersBulkOptions {
  db?: DbClient;
  getShopifyClient?: () => ShopifyClient;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  maxOrders?: number;
}

export class OrdersLiveBulkService {
  private readonly scans = new Map<string, Scan>();
  private readonly live: OrdersLiveService;
  private readonly db: DbClient;
  private readonly getShopifyClient: () => ShopifyClient;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly waitMs: number;
  private readonly maxOrders: number;

  constructor(options: OrdersBulkOptions = {}) {
    this.db = options.db ?? prisma;
    this.getShopifyClient = options.getShopifyClient ?? (() => new ShopifyClient(loadShopifyConfig()));
    this.live = new OrdersLiveService(this.db, this.getShopifyClient);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.waitMs = options.waitMs ?? WAIT_MS;
    this.maxOrders = options.maxOrders ?? MAX_BULK_ORDERS;
  }

  /** Drops finished reads (a CRM change such as a cancellation makes them stale). A running read joins the CRM details at its end, so it stays. */
  clearFinished(): void {
    for (const [key, scan] of this.scans) if (scan.result || scan.error) this.scans.delete(key);
  }

  private assertAllowed(user: Pick<AuthUser, "role">): void {
    if (!ORDER_BULK_ROLES.includes(user.role)) throw new ApiError("Forbidden", STATUS_CODES.FORBIDDEN);
  }

  private client(): ShopifyClient {
    try {
      return this.getShopifyClient();
    } catch {
      throw new ApiError("Shopify is not configured.", STATUS_CODES.SERVICE_UNAVAILABLE);
    }
  }

  async count(user: AuthUser, filters: BulkFilters): Promise<CountResult> {
    this.assertAllowed(user);
    // Date range and search are answered by Shopify itself. Tags are not: the list also re-checks each row's displayed tags.
    if (!hasOverlayFilters(filters) && toList(filters.tags).length === 0) {
      const client = this.client();
      try {
        const counted = await countRecords(client, "orders", await this.live.shopifySearch(client, filters));
        if (counted.exact) return { status: "ready", total: counted.count };
      } catch (error) {
        throw shopifyFailure(error);
      }
    }
    const read = await this.read(user, filters);
    return "rows" in read ? { status: "ready", total: applyOrderFilters(read.rows.map((r) => r.item), filters).length } : read;
  }

  /** Every order matching the filters, whatever page the list is on. */
  async exportFiltered(user: AuthUser, filters: BulkFilters): Promise<ExportResult> {
    this.assertAllowed(user);
    const read = await this.read(user, filters);
    if (!("rows" in read)) return read;
    const matching = new Set(applyOrderFilters(read.rows.map((r) => r.item), filters));
    const rows = read.rows.filter((r) => matching.has(r.item));
    if (rows.length === 0) throw new ApiError("No orders match these filters, so there is nothing to download.", STATUS_CODES.NOT_FOUND);
    return { status: "ready", ...(await this.workbook(rows, "filtered", await this.describe(filters), read.readAt, 0)) };
  }

  /** Only the ticked orders. `ids` are the list's own row ids: a CRM order id, or "shopify:<id>" for an order the CRM has not synced. Each is read fresh from Shopify. */
  async exportSelected(user: AuthUser, ids: string[]): Promise<ExportResult> {
    this.assertAllowed(user);
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) throw new ApiError("Select at least one order to download.", STATUS_CODES.BAD_REQUEST);
    if (wanted.length > MAX_SELECTED_ORDERS) throw new ApiError(`Select at most ${MAX_SELECTED_ORDERS.toLocaleString("en-IN")} orders, or use Download filtered orders.`, STATUS_CODES.BAD_REQUEST);

    const crmIds = wanted.filter((id) => !id.startsWith(LIVE_ORDER_ID_PREFIX));
    const crmRows = crmIds.length ? await this.db.order.findMany({ where: { id: { in: crmIds }, externalSource: "SHOPIFY" }, select: { id: true, externalId: true } }) : [];
    const crmExternal = new Map(crmRows.flatMap((r) => (r.externalId ? [[r.id, normalizeShopifyOrderId(r.externalId)] as const] : [])));
    let unresolved = 0;
    const externalIds = new Set<string>();
    for (const id of wanted) {
      const externalId = id.startsWith(LIVE_ORDER_ID_PREFIX) ? id.slice(LIVE_ORDER_ID_PREFIX.length) : crmExternal.get(id);
      if (externalId && /^\d{1,20}$/.test(externalId)) externalIds.add(externalId);
      else unresolved++;
    }

    const client = this.client();
    const found = new Map<string, NormalizedOrderListItem>();
    const list = [...externalIds];
    try {
      for (let i = 0; i < list.length; i += PAGE_SIZE) {
        const part = list.slice(i, i + PAGE_SIZE);
        const page = await this.page(client, null, part.map((id) => `id:${id}`).join(" OR "));
        // only what was asked for is ever kept, whatever the search returned
        for (const o of page.items) if (externalIds.has(normalizeShopifyOrderId(o.externalId))) found.set(normalizeShopifyOrderId(o.externalId), o);
      }
    } catch (error) {
      throw shopifyFailure(error);
    }
    if (found.size === 0) throw new ApiError("None of the selected orders could be found, so there is nothing to download.", STATUS_CODES.NOT_FOUND);
    const rows = (await this.live.overlayRows(user, [...found.values()])).sort((a, b) => b.item.createdAt.getTime() - a.item.createdAt.getTime());
    const missing = unresolved + externalIds.size - found.size;
    return { status: "ready", ...(await this.workbook(rows, "selected", [["Orders selected", String(wanted.length)]], new Date(this.now()), missing)) };
  }

  private async page(client: ShopifyClient, after: string | null, search: string): Promise<LiveOrdersPage> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await listOrdersForDisplay(client, { first: PAGE_SIZE, after, search });
      } catch (error) {
        if (attempt >= THROTTLE_RETRIES || !isThrottle(error)) throw error;
        await this.sleep(THROTTLE_WAIT_MS);
      }
    }
  }

  /** The unfiltered rows for the date range / search / tags: from the cache, or by starting (or joining) the one running read for them. */
  private async read(user: AuthUser, filters: BulkFilters): Promise<{ rows: Row[]; readAt: Date } | Pending> {
    const key = JSON.stringify([filters.dateFrom?.toISOString() ?? null, filters.dateTo?.toISOString() ?? null, filters.search ?? null, [...toList(filters.tags)].sort()]);
    for (const [k, s] of this.scans) if ((s.result || s.error) && s.expiresAt <= this.now()) this.scans.delete(k);
    let scan = this.scans.get(key);
    if (!scan) {
      if ([...this.scans.values()].filter((s) => !s.result && !s.error).length >= MAX_RUNNING_SCANS) {
        throw new ApiError("Other large order reads are still running. Please try again in a minute.", 429);
      }
      scan = this.start(user, filters);
      this.scans.set(key, scan);
    }
    if (!scan.result && !scan.error) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([scan.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.waitMs)))]);
      clearTimeout(timer);
    }
    if (scan.error) {
      this.scans.delete(key); // reported once; the next request tries again
      throw shopifyFailure(scan.error);
    }
    return scan.result ?? { status: "pending", checked: scan.checked, expected: scan.expected };
  }

  private start(user: AuthUser, filters: BulkFilters): Scan {
    const scan: Scan = { checked: 0, expected: null, done: Promise.resolve(), expiresAt: 0 };
    const run = async () => {
      const client = this.client();
      // built once, so the end of an open range stays fixed while the pages are read
      const search = await this.live.shopifySearch(client, filters);
      const counted = await countRecords(client, "orders", search);
      scan.expected = counted.exact ? counted.count : null;
      if (scan.expected !== null && scan.expected > this.maxOrders) throw tooLarge(scan.expected);
      const seen = new Map<string, NormalizedOrderListItem>(); // by Shopify id: an order can never appear twice
      let after: string | null = null;
      for (;;) {
        const page = await this.page(client, after, search);
        for (const o of page.items) seen.set(normalizeShopifyOrderId(o.externalId), o);
        scan.checked = seen.size;
        if (seen.size > this.maxOrders) throw tooLarge();
        if (!page.hasNextPage) break;
        if (!page.endCursor || page.endCursor === after) throw new ApiError("Shopify stopped part-way through the order list, so the result would be incomplete. Please try again.", 502);
        after = page.endCursor;
      }
      return { rows: await this.live.overlayRows(user, [...seen.values()]), readAt: new Date(this.now()) };
    };
    scan.done = run().then(
      (result) => {
        scan.result = result;
        scan.expiresAt = this.now() + RESULT_TTL_MS;
      },
      (error) => {
        scan.error = error;
        scan.expiresAt = this.now() + FAILURE_TTL_MS;
      },
    );
    return scan;
  }

  /** The applied filters in words, for the file's Summary sheet. */
  private async describe(f: BulkFilters): Promise<[string, string][]> {
    const at = (d: Date) => d.toLocaleString("en-IN", { timeZone: BUSINESS_TIMEZONE, dateStyle: "medium", timeStyle: "medium" });
    const salespersonIds = toList(f.salespersonId);
    const leadSourceIds = toList(f.leadSourceId);
    const [people, sources] = await Promise.all([
      salespersonIds.length ? this.db.user.findMany({ where: { id: { in: salespersonIds } }, select: { name: true } }) : [],
      leadSourceIds.length ? this.db.source.findMany({ where: { id: { in: leadSourceIds } }, select: { name: true } }) : [],
    ]);
    const lines: [string, string][] = [
      ["Created from", f.dateFrom ? at(f.dateFrom) : "(the list's default start date)"],
      ["Created to", f.dateTo ? at(f.dateTo) : "(now)"],
      ["Search", f.search ?? ""],
      ["Order status", toList(f.status).join(", ")],
      ["Fulfilment", toList(f.fulfillment).join(", ")],
      ["Payment method", toList(f.paymentMode).join(", ")],
      ["Payment status", toList(f.paymentStatus).join(", ")],
      ["Order source", toList(f.source).join(", ")],
      ["Salesperson", people.map((p) => p.name).join(", ")],
      ["Lead source", sources.map((s) => s.name).join(", ")],
      ["Tags", toList(f.tags).join(", ")],
      ["Minimum total", f.totalMin === undefined ? "" : String(f.totalMin)],
      ["Maximum total", f.totalMax === undefined ? "" : String(f.totalMax)],
    ];
    return lines.filter(([, value]) => value !== "");
  }

  private async workbook(rows: Row[], kind: "filtered" | "selected", details: [string, string][], readAt: Date, missing: number): Promise<OrdersFile> {
    // Excel has no time zones: dates are written as the business timezone's wall-clock time.
    const wall = new Intl.DateTimeFormat("en-US", { timeZone: BUSINESS_TIMEZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const wallDate = (d: Date) => {
      const p = Object.fromEntries(wall.formatToParts(d).map((x) => [x.type, Number(x.value)]));
      return new Date(Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!));
    };
    const wb = new ExcelJS.Workbook();
    wb.creator = "AyushWellness CRM";
    const sheet = wb.addWorksheet("Orders", { views: [{ state: "frozen", ySplit: 1 }] });
    // the column names of the existing Orders Dashboard export, plus the fields the Orders list holds
    const columns: [string, number, (o: LiveOrderListItem, phone: string | null) => string | number | Date][] = [
      ["Order ID", 18, (o) => o.orderNumber],
      [`Order date (${BUSINESS_TIMEZONE})`, 24, (o) => wallDate(o.createdAt)],
      ["Customer", 26, (o) => o.customer.name],
      ["Phone", 16, (_o, phone) => phone ?? ""],
      ["Lead number", 16, (o) => o.customer.leadNumber ?? ""],
      ["Total", 14, (o) => Number(o.totalAmount)],
      ["Currency", 10, (o) => o.currency],
      ["Items", 8, (o) => o.itemCount],
      ["Payment method", 16, (o) => o.paymentMode ?? ""],
      ["Payment status", 18, (o) => o.paymentStatus ?? "NO_PAYMENT"],
      ["Order status", 18, (o) => o.status ?? ""],
      ["Fulfilment", 20, (o) => o.fulfillmentStatus ?? ""],
      ["Tracking added", 14, (o) => (o.hasTracking ? "Yes" : "No")],
      ["Shipping method", 18, (o) => o.shippingMethod ?? ""],
      ["Order source", 14, (o) => o.source],
      ["Salesperson", 22, (o) => o.salesperson?.name ?? ""],
      ["Lead source", 18, (o) => o.leadSource?.name ?? ""],
      ["Tags", 40, (o) => o.tags.join(", ")],
      ["Synced to CRM", 14, (o) => (o.linkedInCrm ? "Yes" : "No")],
    ];
    sheet.columns = columns.map(([header, width]) => ({ header, width }));
    sheet.getRow(1).font = { bold: true };
    for (const { item, phone } of rows) {
      const row = sheet.addRow(columns.map(([, , value]) => {
        const v = value(item, phone);
        return typeof v === "string" ? safeCell(v) : v;
      }));
      row.getCell(2).numFmt = "dd mmm yyyy hh:mm";
      row.getCell(6).numFmt = "#,##0.00";
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } };
    const summary = wb.addWorksheet("Summary", { views: [{ state: "frozen", ySplit: 1 }] });
    summary.columns = [{ header: "Item", key: "k", width: 30 }, { header: "Value", key: "v", width: 60 }];
    summary.getRow(1).font = { bold: true };
    const lines: [string, string | number][] = [
      ["Download", kind === "filtered" ? "All orders matching the filters" : "Selected orders only"],
      ["Read from Shopify at", readAt.toLocaleString("en-IN", { timeZone: BUSINESS_TIMEZONE, dateStyle: "medium", timeStyle: "medium" })],
      ["Timezone", BUSINESS_TIMEZONE],
      ...details,
      ["Rows in the Orders sheet", rows.length],
      ...(missing > 0 ? [["Selected orders not found", missing] as [string, number]] : []),
    ];
    for (const [k, v] of lines) summary.addRow({ k, v: typeof v === "string" ? safeCell(v) : v });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE }).format(readAt);
    return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: `Orders_${kind}_${day}.xlsx`, rows: rows.length, missing };
  }
}

export const ordersLiveBulkService = new OrdersLiveBulkService();
onClearLiveOrderCaches(() => ordersLiveBulkService.clearFinished());
