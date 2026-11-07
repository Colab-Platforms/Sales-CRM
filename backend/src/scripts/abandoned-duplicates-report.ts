// READ-ONLY dry run: existing duplicate abandoned-checkout groups (same lead + same items + same cart value, new cart id within 60 minutes). Changes nothing.
//   npx tsx src/scripts/abandoned-duplicates-report.ts [--days 10]
import { prisma } from "../lib/prisma.js";
import { duplicateReport } from "../modules/orders/abandoned.dashboard.canonical.js";

const days = Number(process.argv[process.argv.indexOf("--days") + 1]) || 10;
const end = new Date();
const start = new Date(end.getTime() - days * 86_400_000);
const groups = await duplicateReport(prisma, { start, end });
const byDay = new Map<string, { groups: number; extra: number; manual: number }>();
for (const g of groups) {
  const d = byDay.get(g.day) ?? { groups: 0, extra: 0, manual: 0 };
  d.groups += 1; d.extra += g.duplicates.length; if (!g.safeToCollapse) d.manual += 1;
  byDay.set(g.day, d);
}
console.table(Object.fromEntries(byDay));
console.log(JSON.stringify(groups.slice(0, 5), null, 2));
console.log(`groups=${groups.length} extraRows=${groups.reduce((s, g) => s + g.duplicates.length, 0)} needReview=${groups.filter((g) => !g.safeToCollapse).length}`);
await prisma.$disconnect();
