// Shopify -> CRM sync:  npm run shopify:sync -- --limit 5     (add --dry-run to read without writing)
// Prisma is loaded only when a real sync needs it, so a dry run never opens a database connection.
import "dotenv/config";
import { runCli } from "../modules/shopify/shopify.cli.js";

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
