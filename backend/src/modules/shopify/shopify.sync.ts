import { ShopifyApiError, ShopifyGraphQLError, type ShopifyClient } from "./shopify.client.js";
import { fetchCustomer, fetchProduct } from "./shopify.catalog.js";
import { mapCustomer, mapOrder, mapProduct, type MappedOrder } from "./shopify.mapper.js";
import { gidToId, toGid } from "./shopify.money.js";
import { checkConnection, fetchOrder, listRefs, type ConnectionInfo, type NormalizedOrder } from "./shopify.orders.js";
import {
  knownProductIds, knownVersions, upsertCustomerLead, upsertOrder, upsertProduct,
  type Action, type LeadResolution, type OrderResult, type ProductResult, type TxRunner,
} from "./shopify.persist.js";
import { CUSTOMER_REFS_QUERY, ORDER_REFS_QUERY, PRODUCT_REFS_QUERY } from "./shopify.queries.js";

// Pipeline:  Shopify fetch  ->  map  ->  persist.
// With dryRun the persist step is never reached and no TxRunner is needed, so a dry run cannot touch the database.

export type Resource = "orders" | "products" | "customers";

export interface SyncDeps {
  client: ShopifyClient;
  /** Absent for a dry run. */
  runner?: TxRunner;
}

export interface SyncOptions {
  /** Maximum records per resource; null means everything (an explicit --all). */
  limit: number | null;
  since: Date | null;
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

export interface SyncReport {
  dryRun: boolean;
  connection: ConnectionInfo | null;
  scopes: ScopeReport | null;
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
  mapped: MappedOrder | null;
  result: OrderResult | null;
  productsSynced: number;
  productResults: ProductResult[];
}

/** Fetches one order from Shopify in full and stores it. Products it references are fetched first if unknown. */
export async function syncOrderById(deps: SyncDeps, orderGid: string, opts: { force?: boolean } = {}): Promise<OrderSyncOutcome> {
  const runner = requireRunner(deps);
  const raw = await fetchOrder(deps.client, toGid("Order", orderGid));
  if (!raw) return { notFound: true, mapped: null, result: null, productsSynced: 0, productResults: [] };
  const mapped = mapOrder(raw);

  const wanted = [...new Set(raw.items.map((i) => i.productId).filter((id): id is string => !!id))];
  const known = await runner.$transaction((tx) => knownProductIds(tx, wanted.map(gidToId)), TX_OPTIONS);
  const productResults: ProductResult[] = [];
  for (const gid of wanted.filter((g) => !known.has(gidToId(g)))) {
    const outcome = await syncProductById(deps, gid, opts);
    if (outcome.result) productResults.push(outcome.result);
  }

  const result = await withConflictRetry(() => runner.$transaction((tx) => upsertOrder(tx, mapped, opts), TX_OPTIONS));
  return { notFound: false, mapped, result, productsSynced: productResults.length, productResults };
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

export async function syncCustomerById(deps: SyncDeps, customerGid: string): Promise<{ notFound: boolean; result: LeadResolution | null }> {
  const runner = requireRunner(deps);
  const raw = await fetchCustomer(deps.client, toGid("Customer", customerGid));
  if (!raw) return { notFound: true, result: null };
  const mapped = mapCustomer(raw);
  const result = await withConflictRetry(() => runner.$transaction((tx) => upsertCustomerLead(tx, mapped), TX_OPTIONS));
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
  const report: SyncReport = {
    dryRun: options.dryRun,
    connection: null,
    scopes: null,
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
    return report;
  }

  try {
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
  return report;
}

/** Walks a Shopify list page by page until `limit` records have been visited. */
async function walk(
  deps: SyncDeps,
  document: string,
  field: "orders" | "products" | "customers",
  options: SyncOptions,
  visit: (refs: { id: string; updatedAt: string }[]) => Promise<void>,
): Promise<void> {
  let remaining = options.limit ?? Number.POSITIVE_INFINITY;
  let cursor: string | null = null;
  let more = true;
  while (more && remaining > 0) {
    const page = await listRefs(deps.client, document, field, { first: Math.min(remaining, PAGE_SIZE), after: cursor, since: options.since ?? undefined });
    remaining -= page.refs.length;
    await visit(page.refs);
    cursor = page.endCursor;
    more = page.hasNextPage && page.refs.length > 0;
  }
}

async function syncOrders(deps: SyncDeps, options: SyncOptions, report: SyncReport): Promise<void> {
  const counts = report.counts.orders;

  await walk(deps, ORDER_REFS_QUERY, "orders", options, async (refs) => {
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
  await walk(deps, PRODUCT_REFS_QUERY, "products", options, async (refs) => {
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
  await walk(deps, CUSTOMER_REFS_QUERY, "customers", options, async (refs) => {
    for (const ref of refs) {
      try {
        if (options.dryRun) {
          counts.skipped++;
          continue;
        }
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
