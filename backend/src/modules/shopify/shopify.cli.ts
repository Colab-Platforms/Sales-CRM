import { parseArgs } from "node:util";
import { ShopifyClient } from "./shopify.client.js";
import { loadShopifyConfig, ShopifyConfigError } from "./shopify.config.js";
import type { TxRunner } from "./shopify.persist.js";
import { renderReport } from "./shopify.report.js";
import { runSync, type Resource, type SyncOptions } from "./shopify.sync.js";

const DEFAULT_LIMIT = 50;
const DEFAULT_DRY_RUN_LIMIT = 5;
const MAX_LIMIT = 1000;
const MAX_DRY_RUN_LIMIT = 25;
const RESOURCES: Resource[] = ["orders", "products", "customers"];

export const USAGE = [
  "Usage: npm run shopify:sync -- [--dry-run] [--limit N | --all] [--since DATE] [--only LIST] [--force]",
  "",
  "  --dry-run    Read from Shopify and print what would be imported. Writes nothing and never opens the database.",
  `  --limit N    Records per resource (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}; with --dry-run default ${DEFAULT_DRY_RUN_LIMIT}, max ${MAX_DRY_RUN_LIMIT}).`,
  "  --all        Import everything (no limit). Deliberate full backfill; not allowed with --dry-run.",
  "  --since D    Only records updated in Shopify on or after D (YYYY-MM-DD or an ISO date-time).",
  "  --only LIST  Comma-separated: orders, products, customers (default: orders). Orders pull in the products",
  "               and customers they reference; use products/customers only to import those on their own.",
  "  --force      Re-apply records even if Shopify says they have not changed.",
  "",
  "Safe to run repeatedly: records are matched by Shopify id, so a second run updates or skips, never duplicates.",
];

export class CliUsageError extends Error {}

export function parseCliArgs(argv: string[]): SyncOptions {
  let values: { "dry-run"?: boolean; limit?: string; all?: boolean; since?: string; only?: string; force?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "dry-run": { type: "boolean" },
        limit: { type: "string" },
        all: { type: "boolean" },
        since: { type: "string" },
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

  let since: Date | null = null;
  if (values.since !== undefined) {
    since = /^\d{4}-\d{2}-\d{2}$/.test(values.since) ? new Date(`${values.since}T00:00:00Z`) : new Date(values.since);
    if (Number.isNaN(since.getTime())) throw new CliUsageError("--since must be a date such as 2026-09-01.");
  }

  const only = (values.only ?? "orders").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = only.filter((r) => !RESOURCES.includes(r as Resource));
  if (only.length === 0 || bad.length > 0) throw new CliUsageError(`--only must be a comma-separated list of: ${RESOURCES.join(", ")}.`);

  return { limit, since, only: [...new Set(only)] as Resource[], force: values.force === true, dryRun };
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
    const report = await runSync({ client: new ShopifyClient(config, { fetchImpl }), runner }, options);
    renderReport(report, config.apiVersion, config.storeDomain).forEach(safePrint);
    const failed = Object.values(report.counts).reduce((sum, c) => sum + c.failed, 0);
    return report.error || failed > 0 ? 1 : 0;
  } catch (error) {
    safePrint(`Unexpected error (${(error as Error).name}): ${(error as Error).message}`);
    safePrint("Database writes: 0");
    return 1;
  }
}
