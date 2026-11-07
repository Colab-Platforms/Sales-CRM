// 24/7 abandoned-lead pool: resolve / dry-run (read-only) and the two APPLY steps. Nothing is written without --apply, and applying is meant to happen only after explicit approval.
//   npx tsx src/scripts/abandoned-pool.ts resolve              -> are the nine telecallers found, unique and active? (read-only)
//   npx tsx src/scripts/abandoned-pool.ts dry-run              -> unassigned abandoned leads and who would get them (read-only)
//   npx tsx src/scripts/abandoned-pool.ts configure --apply    -> switch the pool on with the nine members (writes two small tables)
//   npx tsx src/scripts/abandoned-pool.ts backfill --apply     -> assign the existing unassigned abandoned leads (never reassigns an owned lead)
import { prisma } from "../lib/prisma.js";
import { assignUnassigned, configurePool, dryRun, resolveCanonicalPool } from "../modules/abandonment/abandonment.pool.service.js";

const [command, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");

async function main() {
  if (command === "resolve") {
    console.table((await resolveCanonicalPool()).map((r) => ({ username: r.username, expected: r.expectedName, found: r.name, userId: r.userId, status: r.status, problem: r.problem ?? "OK" })));
  } else if (command === "dry-run") {
    console.log(JSON.stringify(await dryRun(), null, 2));
  } else if (command === "configure") {
    if (!apply) return void console.log("Dry run only. Re-run with --apply (after approval) to switch the pool on.\n", JSON.stringify(await resolveCanonicalPool(), null, 2));
    console.log(JSON.stringify(await configurePool(), null, 2));
  } else if (command === "backfill") {
    if (!apply) return void console.log("Dry run only. Re-run with --apply (after approval) to assign.\n", JSON.stringify(await dryRun(), null, 2));
    console.log(JSON.stringify(await assignUnassigned({ limit: 5000 }), null, 2));
  } else {
    console.log("Usage: abandoned-pool.ts resolve | dry-run | configure [--apply] | backfill [--apply]");
  }
}
main().finally(() => prisma.$disconnect());
