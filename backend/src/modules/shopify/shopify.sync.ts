import type { ActivitySource } from "../../../generated/prisma/enums.js";
import { ShopifyApiError, ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { fetchCustomer, fetchProduct } from "./shopify.catalog.js";
import { mapCustomer, mapOrder, mapProduct, type MappedOrder } from "./shopify.mapper.js";
import { gidToId, toGid } from "./shopify.money.js";
import { checkConnection, countRecords, fetchOrder, listRefs, type ConnectionInfo, type NormalizedOrder, type RecordCount } from "./shopify.orders.js";
import {
  knownProductIds, knownVersions, upsertCustomerLead, upsertOrder, upsertProduct,
  type Action, type LeadResolution, type OrderResult, type ProductResult, type TxRunner,
} from "./shopify.persist.js";
import { CUSTOMER_REFS_QUERY, ORDER_REFS_QUERY, PRODUCT_REFS_QUERY, type CountField } from "./shopify.queries.js";
import {
  DEFAULT_START_DATE, isValidTimeZone, resolveWindow, startOfDay, windowSearch, type SyncWindow, type WindowSpec,
} from "./shopify.window.js";
import { dispatchOrderLifecycleAutomation } from "../whatsapp/whatsapp.automation.triggers.js";

// Pipeline:  Shopify fetch  ->  map  ->  persist.
// With dryRun the persist step is never reached and no TxRunner is needed, so a dry run cannot touch the database.

export type Resource = "orders" | "products" | "customers";

export interface ProgressEvent {
  resource: Resource;
  /** Records looked at so far in this resource. */
  visited: number;
  /** How many the window holds in Shopify, when known. */
  total: number | null;
}

export interface SyncDeps {
  client: ShopifyClient;
  /** Absent for a dry run. */
  runner?: TxRunner;
  /** First day of the window when --since is not given (SHOPIFY_SYNC_START_DATE). */
  defaultStart?: string;
  /** The clock; the end of the window is fixed to it when the run starts. */
  now?: () => Date;
  /** Called after each page, so a long backfill can show it is alive. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface SyncOptions {
  /** Maximum records per resource; null means everything in the window (an explicit --all). */
  limit: number | null;
  /** Which records: orders created in [from, to), or (with updatedSince) changed recently. */
  window: WindowSpec;
  only: Resource[];
  force: boolean;
  dryRun: boolean;
}

export interface Counts {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
}

export interface SyncFailure {
  resource: Resource;
  ref: string;
  reason: string;
}

export interface PreviewOrder {
  raw: NormalizedOrder;
  mapped: MappedOrder;
}

/** What Shopify says the run could touch. "matching" is an exact count of the window; "upTo" is a ceiling. */
export interface Estimate extends RecordCount {
  kind: "matching" | "upTo";
}

export interface SyncReport {
  dryRun: boolean;
  connection: ConnectionInfo | null;
  scopes: ScopeReport | null;
  /** The resolved date range; null if the run stopped before it could be worked out. */
  window: SyncWindow | null;
  estimate: Partial<Record<Resource, Estimate>>;
  /** Records looked at per resource (whatever happened to them). */
  visited: Record<Resource, number>;
  elapsedMs: number;
  counts: Record<Resource, Counts>;
  leads: { created: number; matched: number; updated: number };
  variants: { created: number; updated: number; skipped: number };
  payments: { created: number; updated: number; deleted: number };
  failures: SyncFailure[];
  warnings: string[];
  /** Dry run only: what each order would look like in the CRM. */
  preview: PreviewOrder[];
  /** Rows created, updated or deleted. Always 0 for a dry run. */
  databaseWrites: number;
  /** A problem that stopped the whole run (bad token, missing scope). */
  error: Error | null;
}

// ---- Scopes ----

/** Scopes this read-only integration needs. A write_X scope also grants read_X in Shopify. */
export const REQUIRED_SCOPES = ["read_orders", "read_customers", "read_products"] as const;
const HISTORICAL_ORDERS_SCOPE = "read_all_orders";

export interface ScopeReport {
  granted: string[];
  /** Required scopes that are not granted, plus any Shopify named in an access-denied error. */
  missing: string[];
  /** Write scopes the token has but this one-way integration does not need. */
  unneededWrite: string[];
  historicalOrders: boolean;
}

export function analyseScopes(granted: string[], deniedByShopify: string[] = []): ScopeReport {
  const has = (scope: string) => granted.includes(scope) || granted.includes(scope.replace(/^read_/, "write_"));
  const missing = new Set<string>(REQUIRED_SCOPES.filter((scope) => !has(scope)));
  for (const scope of deniedByShopify) if (!has(scope)) missing.add(scope);

  return {
    granted,
    missing: [...missing],
    unneededWrite: granted.filter((scope) => scope.startsWith("write_")),
    historicalOrders: has(HISTORICAL_ORDERS_SCOPE),
  };
}

// ---- Single-record sync (also used by the webhook processor) ----

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === "P2002";

/** Two writers can race to create the same new lead or product; the loser simply retries and finds it. */
async function withConflictRetry<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return work();
  }
}

const TX_OPTIONS = { timeout: 30_000, maxWait: 15_000 };

function requireRunner(deps: SyncDeps): TxRunner {
  if (!deps.runner) throw new Error("A database runner is required to write Shopify data");
  return deps.runner;
}

export interface OrderSyncOutcome {
  notFound: boolean;
  /** The order exists but was created before `notBefore`, so it was not imported. */
  outOfWindow: boolean;
  mapped: MappedOrder | null;
  result: OrderResult | null;
  productsSynced: number;
  productResults: ProductResult[];
}

/**
 * Fetches one order from Shopify in full and stores it. Products it references are fetched first if unknown.
 * `notBefore` (the sync start date) makes an older order a no-op; the CLI leaves it out because a --since that
 * reaches further back is an explicit request.
 */
export async function syncOrderById(
  deps: SyncDeps,
  orderGid: string,
  opts: { force?: boolean; notBefore?: Date; source?: ActivitySource } = {},
): Promise<OrderSyncOutcome> {
  const runner = requireRunner(deps);
  const raw = await fetchOrder(deps.client, toGid("Order", orderGid));
  if (!raw) return { notFound: true, outOfWindow: false, mapped: null, result: null, productsSynced: 0, productResults: [] };
  if (opts.notBefore && new Date(raw.createdAt) < opts.notBefore) {
    return { notFound: false, outOfWindow: true, mapped: null, result: null, productsSynced: 0, productResults: [] };
  }
  const mapped = mapOrder(raw);

  const wanted = [...new Set(raw.items.map((i) => i.productId).filter((id): id is string => !!id))];
  const known = await runner.$transaction((tx) => knownProductIds(tx, wanted.map(gidToId)), TX_OPTIONS);
  const productResults: ProductResult[] = [];
  for (const gid of wanted.filter((g) => !known.has(gidToId(g)))) {
    const outcome = await syncProductById(deps, gid, opts);
    if (outcome.result) productResults.push(outcome.result);
  }

  const result = await withConflictRetry(() =>
    runner.$transaction((tx) => upsertOrder(tx, mapped, { force: opts.force, source: opts.source }), TX_OPTIONS),
  );
  // E7.6: strictly after the order transaction above has committed, so a WhatsApp automation
  // outcome can never affect (let alone roll back) the order sync itself - see the doc comment on
  // dispatchOrderLifecycleAutomation.
  await dispatchOrderLifecycleAutomation(result);
  return { notFound: false, outOfWindow: false, mapped, result, productsSynced: productResults.length, productResults };
}

export async function syncProductById(
  deps: SyncDeps,
  productGid: string,
  opts: { force?: boolean } = {},
): Promise<{ notFound: boolean; result: ProductResult | null }> {
  const runner = requireRunner(deps);
  const raw = await fetchProduct(deps.client, toGid("Product", productGid));
  if (!raw) return { notFound: true, result: null };
  const mapped = mapProduct(raw);
  const result = await withConflictRetry(() => runner.$transaction((tx) => upsertProduct(tx, mapped, opts), TX_OPTIONS));
  return { notFound: false, result };
}

/**
 * With `notBefore`, a customer created before it only updates a lead the CRM already has; it never creates one.
 * `result` is null when the customer was left alone for that reason.
 */
export async function syncCustomerById(
  deps: SyncDeps,
  customerGid: string,
  opts: { notBefore?: Date } = {},
): Promise<{ notFound: boolean; result: LeadResolution | null }> {
  const runner = requireRunner(deps);
  const raw = await fetchCustomer(deps.client, toGid("Customer", customerGid));
  if (!raw) return { notFound: true, result: null };
  const mapped = mapCustomer(raw);
  const historical = !!opts.notBefore && !!raw.createdAt && new Date(raw.createdAt) < opts.notBefore;
  const result = await withConflictRetry(() =>
    runner.$transaction((tx) => upsertCustomerLead(tx, mapped, { createIfMissing: !historical }), TX_OPTIONS),
  );
  return { notFound: false, result };
}

// ---- Batch sync (the CLI) ----

const emptyCounts = (): Counts => ({ created: 0, updated: 0, skipped: 0, failed: 0 });
const PAGE_SIZE = 50;

/** A problem that would hit every record (bad token, missing scope) should stop the run, not fail each one. */
export function isFatal(error: unknown): boolean {
  if (error instanceof ShopifyGraphQLError) return error.requiredScopes.length > 0;
  return error instanceof ShopifyApiError && (error.status === 401 || error.status === 403);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0] : "Unknown error");

const bump = (counts: Counts, action: Action) => void (counts[action === "created" ? "created" : action === "updated" ? "updated" : "skipped"]++);

export async function runSync(deps: SyncDeps, options: SyncOptions): Promise<SyncReport> {
  const startedAt = performance.now();
  const report: SyncReport = {
    dryRun: options.dryRun,
    connection: null,
    scopes: null,
    window: null,
    estimate: {},
    visited: { orders: 0, products: 0, customers: 0 },
    elapsedMs: 0,
    counts: { orders: emptyCounts(), products: emptyCounts(), customers: emptyCounts() },
    leads: { created: 0, matched: 0, updated: 0 },
    variants: { created: 0, updated: 0, skipped: 0 },
    payments: { created: 0, updated: 0, deleted: 0 },
    failures: [],
    warnings: [],
    preview: [],
    databaseWrites: 0,
    error: null,
  };

  try {
    report.connection = await checkConnection(deps.client);
    report.scopes = analyseScopes(report.connection.scopes);
  } catch (error) {
    report.error = error as Error;
    report.elapsedMs = performance.now() - startedAt;
    return report;
  }

  // Calendar days are read in the store's own time zone; UTC only if Shopify gave none we can use.
  const zone = report.connection.timeZone;
  const timeZone = zone && isValidTimeZone(zone) ? zone : "UTC";
  if (timeZone !== zone) report.warnings.push("Could not read the store time zone from Shopify; dates in the window are read as UTC.");
  const defaultStart = deps.defaultStart ?? DEFAULT_START_DATE;
  try {
    report.window = resolveWindow(options.window, defaultStart, timeZone, (deps.now ?? (() => new Date()))());
  } catch (error) {
    report.error = error as Error;
    report.elapsedMs = performance.now() - startedAt;
    return report;
  }
  if (options.window.from && report.window.createdFrom < startOfDay(defaultStart, timeZone)) {
    report.warnings.push(`The window starts before the configured start date (${defaultStart}); orders older than that are imported because --since asked for them.`);
  }

  try {
    await estimate(deps, options, report.window, report);
    if (options.only.includes("products")) await syncProducts(deps, options, report);
    if (options.only.includes("customers")) await syncCustomers(deps, options, report);
    if (options.only.includes("orders")) await syncOrders(deps, options, report);
  } catch (error) {
    report.error = error as Error;
    if (error instanceof ShopifyGraphQLError) report.scopes = analyseScopes(report.connection.scopes, error.requiredScopes);
  }

  const c = report.counts;
  report.databaseWrites = options.dryRun
    ? 0
    : c.orders.created + c.orders.updated + c.products.created + c.products.updated + c.customers.created + c.customers.updated +
      report.leads.created + report.leads.updated + report.variants.created + report.variants.updated +
      report.payments.created + report.payments.updated + report.payments.deleted;
  report.elapsedMs = performance.now() - startedAt;
  return report;
}

/**
 * Asks Shopify how many records the window holds, so a dry run (and the top of a real run) can say how big the job is
 * before it starts. Failing to count is only a warning; a missing scope stops the run like any other read.
 */
async function estimate(deps: SyncDeps, options: SyncOptions, window: SyncWindow, report: SyncReport): Promise<void> {
  const search = windowSearch(window);
  const count = async (field: CountField, kind: Estimate["kind"], query: string | null) => {
    try {
      report.estimate[field] = { ...(await countRecords(deps.client, field, query)), kind };
    } catch (error) {
      if (isFatal(error)) throw error;
      report.warnings.push(`Could not count ${field} in Shopify: ${reasonOf(error)}`);
    }
  };

  if (options.only.includes("orders")) {
    await count("orders", "matching", search);
    // Orders pull in their customers and products; each is at most one per order / the whole catalogue.
    const orders = report.estimate.orders;
    if (orders && !options.only.includes("customers")) report.estimate.customers = { count: orders.count, exact: false, kind: "upTo" };
    if (!options.only.includes("products")) await count("products", "upTo", null);
  }
  if (options.only.includes("products")) await count("products", "matching", search);
  if (options.only.includes("customers")) await count("customers", "matching", search);
}

/**
 * Walks the window page by page, oldest first, until `limit` records have been visited. Oldest-first by creation
 * time is stable while the walk runs; with an updatedSince filter the walk is by update time instead, where an
 * edit only moves a record later, never past the cursor.
 */
async function walk(
  deps: SyncDeps,
  document: string,
  field: Resource,
  options: SyncOptions,
  report: SyncReport,
  visit: (refs: { id: string; updatedAt: string }[]) => Promise<void>,
): Promise<void> {
  const window = report.window!;
  const search = windowSearch(window);
  const sortKey = window.updatedSince ? "UPDATED_AT" : "CREATED_AT";
  let remaining = options.limit ?? Number.POSITIVE_INFINITY;
  let cursor: string | null = null;
  let more = true;
  while (more && remaining > 0) {
    const page = await listRefs(deps.client, document, field, { first: Math.min(remaining, PAGE_SIZE), after: cursor, search, sortKey });
    remaining -= page.refs.length;
    await visit(page.refs);
    report.visited[field] += page.refs.length;
    const total = report.estimate[field];
    deps.onProgress?.({ resource: field, visited: report.visited[field], total: total?.kind === "matching" ? total.count : null });
    cursor = page.endCursor;
    more = page.hasNextPage && page.refs.length > 0;
  }
}

async function syncOrders(deps: SyncDeps, options: SyncOptions, report: SyncReport): Promise<void> {
  const counts = report.counts.orders;

  await walk(deps, ORDER_REFS_QUERY, "orders", options, report, async (refs) => {
    const known = options.dryRun || !deps.runner
      ? new Map<string, Date>()
      : await deps.runner.$transaction((tx) => knownVersions(tx, "order", refs.map((r) => gidToId(r.id))), TX_OPTIONS);

    for (const ref of refs) {
      try {
        if (options.dryRun) {
          const raw = await fetchOrder(deps.client, ref.id);
          if (raw) report.preview.push({ raw, mapped: mapOrder(raw) });
          continue;
        }

        // Unchanged in Shopify since the last sync: skip without fetching the full order.
        const seen = known.get(gidToId(ref.id));
        if (!options.force && seen && seen >= new Date(ref.updatedAt)) {
          counts.skipped++;
          continue;
        }

        const outcome = await syncOrderById(deps, ref.id, { force: options.force });
        if (outcome.notFound || !outcome.result) {
          counts.skipped++;
          continue;
        }
        bump(counts, outcome.result.action);
        if (outcome.result.action !== "skipped") {
          if (outcome.result.lead) report.leads[outcome.result.lead.action]++;
          report.payments.created += outcome.result.payments.created;
          report.payments.updated += outcome.result.payments.updated;
          report.payments.deleted += outcome.result.payments.deleted;
        }
        for (const product of outcome.productResults) {
          bump(report.counts.products, product.action);
          report.variants.created += product.variants.created;
          report.variants.updated += product.variants.updated;
          report.variants.skipped += product.variants.skipped;
        }
        if (outcome.mapped) for (const warning of outcome.mapped.warnings) report.warnings.push(`${outcome.mapped.externalNumber}: ${warning}`);
      } catch (error) {
        if (isFatal(error)) throw error;
        counts.failed++;
        report.failures.push({ resource: "orders", ref: ref.id, reason: reasonOf(error) });
      }
    }
  });
}

async function syncProducts(deps: SyncDeps, options: SyncOptions, report: SyncReport): Promise<void> {
  const counts = report.counts.products;
  await walk(deps, PRODUCT_REFS_QUERY, "products", options, report, async (refs) => {
    const known = options.dryRun || !deps.runner
      ? new Map<string, Date>()
      : await deps.runner.$transaction((tx) => knownVersions(tx, "product", refs.map((r) => gidToId(r.id))), TX_OPTIONS);

    for (const ref of refs) {
      try {
        if (options.dryRun) {
          const raw = await fetchProduct(deps.client, ref.id);
          if (raw) counts.skipped++; // counted as "seen" only; nothing is written
          continue;
        }
        const seen = known.get(gidToId(ref.id));
        if (!options.force && seen && seen >= new Date(ref.updatedAt)) {
          counts.skipped++;
          continue;
        }
        const outcome = await syncProductById(deps, ref.id, { force: options.force });
        if (!outcome.result) {
          counts.skipped++;
          continue;
        }
        bump(counts, outcome.result.action);
        report.variants.created += outcome.result.variants.created;
        report.variants.updated += outcome.result.variants.updated;
        report.variants.skipped += outcome.result.variants.skipped;
      } catch (error) {
        if (isFatal(error)) throw error;
        counts.failed++;
        report.failures.push({ resource: "products", ref: ref.id, reason: reasonOf(error) });
      }
    }
  });
}

async function syncCustomers(deps: SyncDeps, options: SyncOptions, report: SyncReport): Promise<void> {
  const counts = report.counts.customers;
  await walk(deps, CUSTOMER_REFS_QUERY, "customers", options, report, async (refs) => {
    for (const ref of refs) {
      try {
        if (options.dryRun) {
          counts.skipped++;
          continue;
        }
        // No start-date floor here: the window already limits which customers this walk visits.
        const outcome = await syncCustomerById(deps, ref.id);
        if (!outcome.result) {
          counts.skipped++;
          continue;
        }
        // An existing, unchanged lead counts as skipped; a new or filled-in one as created/updated.
        if (outcome.result.action === "created") counts.created++;
        else if (outcome.result.action === "updated") counts.updated++;
        else counts.skipped++;
        report.leads[outcome.result.action]++;
      } catch (error) {
        if (isFatal(error)) throw error;
        counts.failed++;
        report.failures.push({ resource: "customers", ref: ref.id, reason: reasonOf(error) });
      }
    }
  });
}
