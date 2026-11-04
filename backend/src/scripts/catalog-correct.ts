// Applies a reviewed measurement-corrections CSV (see docs/measurement-corrections-template-2026-11-04.csv).
//
//   npm run catalog-correct -- <file.csv>            DRY RUN (default): reads the database, writes nothing, shows exactly which SKU and fields would change
//   npm run catalog-correct -- <file.csv> --apply    writes the planned changes in ONE transaction - but only when the file has no errors at all
//
// Only the SKUs and fields with a value in the file are touched; a blank cell never changes anything; an unknown SKU, an invalid / zero / negative value or a recorded value on a FILL row is an error.
import { prisma } from "@/lib/prisma.js";
import { applyCorrections, formatPlan, planCorrections, readCorrectionCsv } from "../modules/products/products.measurement-corrections.js";

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!file) throw new Error("Usage: catalog-correct <file.csv> [--apply]");

  const plan = await planCorrections(readCorrectionCsv(file));
  if (apply && plan.errors.length === 0) await applyCorrections(plan);
  console.log(apply && plan.errors.length === 0 ? "APPLIED" : apply ? "NOT APPLIED (errors below, nothing was written)" : "DRY RUN (nothing written)");
  formatPlan(plan, apply && plan.errors.length === 0).forEach((l) => console.log(l));
  if (plan.errors.length > 0) process.exitCode = 1;
  else if (!apply && plan.items.length > 0) console.log("\nReview the changes above, then run the same command with --apply.");
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
