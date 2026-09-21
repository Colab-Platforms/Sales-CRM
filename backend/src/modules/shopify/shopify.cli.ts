import { parseArgs } from "node:util";
import { ShopifyClient } from "./shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "./shopify.config.js";
import type { TxRunner } from "./shopify.persist.js";
import { renderReport } from "./shopify.report.js";
import { runSync, type ProgressEvent, type Resource, type SyncOptions } from "./shopify.sync.js";
import { DEFAULT_START_DATE, parseDateSpec, parseUpdatedSince, WindowError, type WindowSpec } from "./shopify.window.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_DRY_RUN_LIMIT = 5;
const MAX_LIMIT = 1000;
const MAX_DRY_RUN_LIMIT = 25;
const RESOURCES: Resource[] = ["orders", "products", "customers"];
const PROGRESS_EVERY_MS = 30_000;

export const USAGE = [
  "Usage: npm run shopify:sync -- [--dry-run] [--limit N | --all] [--since D] [--until D] [--updated-since D] [--only LIST] [--force]",
  "",
  "Which records (the window):",
  `  --since D          Orders created on or after D. Default: SHOPIFY_SYNC_START_DATE (${DEFAULT_START_DATE}). Older orders are`,
  "                     never imported unless you pass an earlier date here.",
  "  --until D          Orders created up to the end of day D. Default: now (fixed when the run starts).",
  "  --updated-since D  Incremental catch-up: only records changed in Shopify since D, still inside the window.",
  "                     D may also be 24h or 7d. Use it to reconcile anything the webhooks missed.",
  "                     D is YYYY-MM-DD (read in the store's time zone) or a date-time with a zone, e.g. 2026-01-01T00:00:00+05:30.",
  "",
  "How much:",
  "  --dry-run    Read from Shopify and print the window, how many records it holds, and a sample. Writes nothing and never",
  "               opens the database.",
  `  --limit N    Stop after N records per resource (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}; with --dry-run default ${DEFAULT_DRY_RUN_LIMIT}, max ${MAX_DRY_RUN_LIMIT}).`,
  "               Oldest first, so a limited run and the next run cover the window in order.",
  "  --all        No limit: import the whole window. Deliberate full backfill; run --dry-run first. Not allowed with --dry-run.",
  "",
  "Other:",
  "  --only LIST  Comma-separated: orders, products, customers (default: orders). Orders pull in the products",
  "               and customers they reference. products/customers alone are filtered by their own creation date.",
  "  --force      Re-apply records even if Shopify says they have not changed.",
  "",
  "Safe to run repeatedly and to resume: records are matched by Shopify id, so a second run updates or skips, never duplicates.",
];

export class CliUsageError extends Error {}

export function parseCliArgs(argv: string[], now: Date = new Date()): SyncOptions {
  let values: {
    "dry-run"?: boolean; limit?: string; all?: boolean; since?: string; until?: string; "updated-since"?: string; only?: string; force?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean" },
        limit: { type: "string" },
        all: { type: "boolean" },
        since: { type: "string" },
        until: { type: "string" },
        "updated-since": { type: "string" },
        only: { type: "string" },
        force: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new CliUsageError((error as Error).message);
  }

  const dryRun = values["dry-run"] === true;
  if (values.all && values.limit !== undefined) throw new CliUsageError("Use either --limit or --all, not both.");
  if (values.all && dryRun) throw new CliUsageError("--all can not be combined with --dry-run; use --limit (max 25).");
  if (values.force && dryRun) throw new CliUsageError("--force has no meaning with --dry-run.");

  const maxLimit = dryRun ? MAX_DRY_RUN_LIMIT : MAX_LIMIT;
  let limit: number | null = dryRun ? DEFAULT_DRY_RUN_LIMIT : DEFAULT_LIMIT;
  if (values.all) limit = null;
  else if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      throw new CliUsageError(`--limit must be a whole number from 1 to ${maxLimit}.`);
    }
  }

  let window: WindowSpec;
  try {
    window = {
      from: values.since !== undefined ? parseDateSpec(values.since, "--since") : null,
      to: values.until !== undefined ? parseDateSpec(values.until, "--until") : null,
      updatedSince: values["updated-since"] !== undefined ? parseUpdatedSince(values["updated-since"], now) : null,
    };
  } catch (error) {
    if (error instanceof WindowError) throw new CliUsageError(error.message);
    throw error;
  }

  const only = (values.only ?? "orders").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = only.filter((r) => !RESOURCES.includes(r as Resource));
  if (only.length === 0 || bad.length > 0) throw new CliUsageError(`--only must be a comma-separated list of: ${RESOURCES.join(", ")}.`);

  return { limit, window, only: [...new Set(only)] as Resource[], force: values.force === true, dryRun };
}

export interface CliDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  fetchImpl?: typeof fetch;
  /** Creates the database runner on demand. Never called for a dry run. */
  getRunner?: () => Promise<TxRunner>;
}

/** Runs the command and returns the process exit code: 0 ok, 1 failed, 2 bad usage. */
export async function runCli({ argv, env, print, fetchImpl, getRunner }: CliDeps): Promise<number> {
  let options: SyncOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    print(`Error: ${(error as Error).message}`);
    USAGE.forEach((line) => print(line));
    return 2;
  }

  let config;
  try {
    config = loadShopifyConfig(env);
  } catch (error) {
    if (!(error instanceof ShopifyConfigError)) throw error;
    print(error.message);
    print("Database writes: 0");
    return 1;
  }

  // Last line of defence: nothing printed can contain the token, whatever produced it.
  const token = config.accessToken;
  const safePrint = (line: string) => print(line.split(token).join("[REDACTED]"));

  try {
    if (!options.dryRun && !getRunner) throw new Error("No database is available for a real sync");
    const runner = options.dryRun ? undefined : await getRunner!();
    // A full backfill runs for a long time; say so every half minute instead of staying silent.
    let lastProgress = Date.now();
    const onProgress = ({ resource, visited, total }: ProgressEvent) => {
      if (Date.now() - lastProgress < PROGRESS_EVERY_MS) return;
      lastProgress = Date.now();
      safePrint(`... ${resource}: ${visited}${total === null ? "" : ` of ${total}`} looked at`);
    };
    const deps = { client: new ShopifyClient(config, { fetchImpl }), runner, defaultStart: config.syncStartDate, onProgress };
    const report = await runSync(deps, options);
    renderReport(report, config.apiVersion, config.storeDomain, options.limit).forEach(safePrint);
    const failed = Object.values(report.counts).reduce((sum, c) => sum + c.failed, 0);
    return report.error || failed > 0 ? 1 : 0;
  } catch (error) {
    safePrint(`Unexpected error (${(error as Error).name}): ${(error as Error).message}`);
    safePrint("Database writes: 0");
    return 1;
  }
}
