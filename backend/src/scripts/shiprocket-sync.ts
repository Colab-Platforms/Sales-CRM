// Shiprocket -> CRM backfill: imports shipment/tracking data that ALREADY EXISTS in the Shiprocket account into the
// CRM's Shipment table.  npm run shiprocket:sync -- --since 2026-01-01 --limit 10 --dry-run
//
// Read-only towards Shiprocket: only GET /orders is ever called. Never creates an order/shipment, never assigns an
// AWB, never schedules a pickup, never generates a label - see shiprocket.backfill.ts for exactly what it does.
import "dotenv/config";
import { runCli } from "../modules/shiprocket/shiprocket.cli.js";

const database: { close?: () => Promise<void> } = {};

const code = await runCli({
  argv: process.argv.slice(2),
  env: process.env,
  print: (line) => console.log(line),
  getRunner: async () => {
    const { prisma } = await import("../lib/prisma.js");
    database.close = () => prisma.$disconnect();
    return prisma;
  },
});

await database.close?.();
process.exitCode = code;
