import { parseArgs } from "node:util";
import { ShiprocketClient } from "./shiprocket.client.js";
import { loadShiprocketConfig, ShiprocketConfigError } from "./shiprocket.config.js";
import { runShiprocketBackfill, type BackfillOptions, type BackfillReport } from "./shiprocket.backfill.js";
import type { TxRunner } from "../integrations/integrations.common.js";

// Shiprocket -> CRM read-only backfill CLI. Mirrors shopify.cli.ts's shape (usage, arg parsing, exit codes) for a
// familiar operator experience, but this command never writes to Shiprocket: it only ever calls GET /orders.

const DEFAULT_LIMIT = 50;
const DEFAULT_DRY_RUN_LIMIT = 10;
const MAX_LIMIT = 1000;
const MAX_DRY_RUN_LIMIT = 25;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const USAGE = [
  "Usage: npm run shiprocket:sync -- [--dry-run] [--limit N | --all] [--since D] [--until D]",
  "",
  "Read-only: imports shipment/tracking data that ALREADY EXISTS in the Shiprocket account into the CRM's Shipment",
  "table. Never creates an order/shipment in Shiprocket, never assigns an AWB, never schedules a pickup, never",
  "generates a label - only GET /orders (Shiprocket's own order listing) is ever called.",
  "",
  "  --since D    Orders created on or after D (YYYY-MM-DD). Default: 2026-01-01, matching the Shopify backfill's own start date.",
  "  --until D    Orders created up to and including D (YYYY-MM-DD). Default: today.",
  "  --dry-run    Read from Shiprocket and print what would happen. Writes nothing to the database.",
  `  --limit N    Stop after N shipments (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}; with --dry-run default ${DEFAULT_DRY_RUN_LIMIT}, max ${MAX_DRY_RUN_LIMIT}).`,
  "  --all        No limit: import the whole window. Deliberate full backfill; run --dry-run first. Not allowed with --dry-run.",
  "",
  "Safe to run repeatedly: shipments are matched by Shiprocket id, AWB or Shiprocket order id, so a second run",
  "updates or skips, never duplicates.",
];

export class CliUsageError extends Error {}

export interface ParsedArgs {
  since: string;
  until: string;
  limit: number | null;
  dryRun: boolean;
}

export function parseCliArgs(argv: string[], now: Date = new Date()): ParsedArgs {
  let values: { "dry-run"?: boolean; limit?: string; all?: boolean; since?: string; until?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" }, limit: { type: "string" }, all: { type: "boolean" }, since: { type: "string" }, until: { type: "string" } }, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new CliUsageError((error as Error).message);
  }

  const dryRun = values["dry-run"] === true;
  if (values.all && values.limit !== undefined) throw new CliUsageError("Use either --limit or --all, not both.");
  if (values.all && dryRun) throw new CliUsageError("--all can not be combined with --dry-run; use --limit (max 25).");

  const maxLimit = dryRun ? MAX_DRY_RUN_LIMIT : MAX_LIMIT;
  let limit: number | null = dryRun ? DEFAULT_DRY_RUN_LIMIT : DEFAULT_LIMIT;
  if (values.all) limit = null;
  else if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) throw new CliUsageError(`--limit must be a whole number from 1 to ${maxLimit}.`);
  }

  const day = (value: string, flag: string): string => {
    if (!DAY.test(value)) throw new CliUsageError(`${flag} must be a date such as 2026-01-01.`);
    return value;
  };
  const since = values.since !== undefined ? day(values.since, "--since") : "2026-01-01";
  const until = values.until !== undefined ? day(values.until, "--until") : now.toISOString().slice(0, 10);
  if (since > until) throw new CliUsageError("--since must not be after --until.");

  return { since, until, limit, dryRun };
}

export interface CliDeps {
  argv: string[];
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  fetchImpl?: typeof fetch;
  // Called for both a dry run and a real sync: a meaningful dry run still needs to READ the CRM database to show
  // which CRM order each Shiprocket shipment would actually match. Only writes are gated behind `dryRun`, inside
  // matchAndApply itself (shiprocket.backfill.ts) - every write there returns *before* touching the database when
  // dryRun is true, so handing a dry run a real connection can never result in a write.
  getRunner: () => Promise<TxRunner>;
}

const counts = (c: BackfillReport["counts"]) => `discovered ${c.discovered} | created ${c.created} | updated ${c.updated} | skipped ${c.skipped} | failed ${c.failed}`;

function renderReport(report: BackfillReport, dryRun: boolean, limit: number | null): string[] {
  const lines: string[] = [];
  lines.push(`Shiprocket connection: ${report.connection}`);
  lines.push(`Mode: ${dryRun ? "dry run (nothing is written)" : "sync"}`);
  if (report.connectionError) lines.push(`Reason: ${report.connectionError}`);
  const w = report.windows;
  if (w.length > 0) {
    lines.push(`Date window: ${w[0]!.from} -> ${w[w.length - 1]!.to}${w.length > 1 ? ` (split into ${w.length} requests of up to 30 days each - Shiprocket's own limit)` : ""}`);
  }
  lines.push(`This run: ${limit === null ? "no limit (--all)" : `up to ${limit} shipments (--limit ${limit})`}`);
  lines.push(`Shipments discovered: ${report.counts.discovered}`);
  lines.push(counts(report.counts));
  lines.push(`Database writes: ${report.databaseWrites}`);
  lines.push(`Shiprocket API calls: ${report.apiCalls.listOrders} GET /orders | ${report.apiCalls.track} GET /courier/track/awb (all read-only)`);
  lines.push(
    `Tracking: ${report.tracking.withAwb} shipment(s) had an AWB | ${report.tracking.succeeded} tracking call(s) succeeded | ${report.tracking.failed} failed | ${report.counts.discovered - report.tracking.withAwb} had no AWB (status not verifiable through tracking)`,
  );
  if (report.tracking.descriptiveStatuses.length > 0) lines.push(`Descriptive statuses seen from tracking: ${report.tracking.descriptiveStatuses.join(", ")}`);
  if (report.tracking.unknownStatuses.length > 0) lines.push(`Unknown to mapShiprocketStatus() (not guessed, reported as-is): ${report.tracking.unknownStatuses.join(", ")}`);
  const crmStatusEntries = Object.entries(report.crmStatusCounts);
  if (crmStatusEntries.length > 0) lines.push(`CRM status mapping: ${crmStatusEntries.map(([status, n]) => `${status} x${n}`).join(" | ")}`);
  lines.push(`Elapsed: ${(report.elapsedMs / 1000).toFixed(1)}s`);

  if (report.fatalError) lines.push("", `Result: FAIL`, `Reason: ${report.fatalError}`);
  if (report.failures.length > 0) {
    lines.push("", `Failures / skips with a reason (${report.failures.length}):`);
    report.failures.slice(0, 15).forEach((f) => lines.push(`  - Shiprocket order ${f.ref}: ${f.reason}`));
  }
  if (dryRun && report.preview.length > 0) {
    lines.push("", `Preview (first ${report.preview.length}) - Shiprocket list status | AWB | tracking status | CRM status:`);
    report.preview.forEach((p) => {
      const trackingCol = p.trackingStatus ?? (p.trackingError ? `FAILED (${p.trackingError})` : p.awb ? "not attempted" : "no AWB - not verifiable");
      lines.push(`  - Shiprocket order ${p.shiprocketOrderId} | list status "${p.listStatus ?? "-"}" | AWB ${p.awb ?? "-"} | tracking status "${trackingCol}" | CRM status ${p.crmStatus ?? "UNMAPPED"} | channel order id "${p.channelOrderId ?? "-"}" -> ${p.outcome}`);
    });
  }
  return lines;
}

/** Runs the command and returns the process exit code: 0 ok, 1 failed, 2 bad usage. */
export async function runCli({ argv, env, print, fetchImpl, getRunner }: CliDeps): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    print(`Error: ${(error as Error).message}`);
    USAGE.forEach((line) => print(line));
    return 2;
  }

  let config;
  try {
    config = loadShiprocketConfig(env);
  } catch (error) {
    if (!(error instanceof ShiprocketConfigError)) throw error;
    print(error.message);
    print("Database writes: 0");
    return 1;
  }

  try {
    const runner = await getRunner();
    const client = new ShiprocketClient(config, fetchImpl);
    let lastProgress = Date.now();
    const options: BackfillOptions = { since: args.since, until: args.until, limit: args.limit, dryRun: args.dryRun };
    const report = await runShiprocketBackfill(
      {
        client,
        runner,
        onProgress: (discovered) => {
          const now = Date.now();
          if (now - lastProgress < 30_000) return;
          lastProgress = now;
          print(`... ${discovered} shipments looked at`);
        },
      },
      options,
    );
    renderReport(report, args.dryRun, args.limit).forEach(print);
    return report.fatalError || report.counts.failed > 0 ? 1 : 0;
  } catch (error) {
    print(`Unexpected error (${(error as Error).name}): ${(error as Error).message}`);
    print("Database writes: 0");
    return 1;
  }
}
