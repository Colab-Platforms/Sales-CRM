// Fills MISSING product / variant weight and dimensions in the CRM from a Shiprocket catalogue CSV (see docs/shiprocket-catalog-2026-11-04.csv).
//
//   npm run catalog-fill -- <file.csv>            DRY RUN (default): reads the database, writes nothing, prints the plan and what would still be missing
//   npm run catalog-fill -- <file.csv> --apply    makes the planned writes
//
// Only measurements the CRM does not have are written: a recorded weight is never replaced, and the three dimensions are written together only when none is recorded. A 0 / blank in the
// catalogue is "not recorded" and is skipped, so nothing is ever invented. Identity (names, SKUs, Shopify ids) is never touched.
import { prisma } from "@/lib/prisma.js";
import { importCatalogRows, readCatalogCsv, type FailedRow } from "../modules/products/products.catalog-import.js";

type Plan = { sku: string; kind: "product" | "variant"; data: Record<string, number> }[];
const positive = (v: { toString(): string } | number | null | undefined) => v !== null && v !== undefined && Number(v.toString()) > 0;

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  const apply = args.includes("--apply");
  if (!file) throw new Error("Usage: catalog-fill <file.csv> [--apply]");

  const plan: Plan = [];
  const failed: FailedRow[] = [];
  const summary = await importCatalogRows(readCatalogCsv(file), { fillMissingOnly: true, dryRun: !apply, plan, failedRows: failed });
  console.log(`${apply ? "APPLIED" : "DRY RUN (nothing written)"}: ${JSON.stringify(summary)}`);
  for (const p of plan) console.log(`  ${apply ? "wrote" : "would write"} ${p.kind} ${p.sku}: ${JSON.stringify(p.data)}`);
  for (const f of failed.filter((f) => f.status === "unmatched")) console.log(`  not in the CRM: ${f.sku}`);

  // What an order would still lack after this (so the remaining gaps are known before any order fails).
  const planned = new Map(plan.map((p) => [`${p.kind}:${p.sku}`, p.data]));
  const [variants, products] = await Promise.all([
    prisma.productVariant.findMany({ select: { sku: true, name: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true, product: { select: { name: true } } } }),
    prisma.product.findMany({ where: { variants: { none: {} } }, select: { sku: true, name: true, weightKg: true, lengthCm: true, widthCm: true, heightCm: true } }),
  ]);
  const gaps: string[] = [];
  let complete = 0;
  const check = (kind: "variant" | "product", sku: string | null, label: string, m: { weightKg: unknown; lengthCm: unknown; widthCm: unknown; heightCm: unknown }) => {
    const add = (sku ? planned.get(`${kind}:${sku}`) : undefined) ?? {};
    const has = (k: "weightKg" | "lengthCm" | "widthCm" | "heightCm") => positive((add as Record<string, number>)[k] ?? (m[k] as never));
    const missing = [!has("weightKg") && "weight", !has("lengthCm") && "length", !has("widthCm") && "breadth", !has("heightCm") && "height"].filter(Boolean);
    if (missing.length === 0) complete++;
    else gaps.push(`  ${sku ?? "(no SKU)"}  ${label}: ${missing.join(", ")}`);
  };
  for (const v of variants) check("variant", v.sku, `${v.product.name} - ${v.name}`, v);
  for (const p of products) check("product", p.sku, p.name, p);
  console.log(`\nAfter this ${apply ? "import" : "plan"}: ${complete} sellable item(s) have complete measurements, ${gaps.length} do not:`);
  gaps.forEach((g) => console.log(g));
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
