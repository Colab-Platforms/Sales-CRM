// Packed parcel dimensions vs product dimensions, the automatic rate inputs, and the catalog import UI.
// Run with: ../backend/node_modules/.bin/tsx --test components/whatsapp/inbox/package-dimensions.test.tsx
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateOrderDialog } from "./create-order-dialog";
import { CatalogImportProgress } from "@/components/products/catalog-import-panel";
import { productListQueryOptions } from "@/lib/api-client/queries/products.queries";
import type { CatalogImportStatus, ProductListItem } from "@/lib/api-client/types/products.types";
import { dimensionsHint, formatDimensions, goodsValue, parseParcelDimensions, resolvePackedDimensions, suggestPackedDimensions } from "@/lib/package-dimensions";
import { importPercent, progressLabel } from "@/lib/catalog-import";

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const U = { lengthCm: "20", widthCm: "15", heightCm: "2" };

describe("packed parcel dimensions are never derived by adding up product dimensions", () => {
  it("one unit of one product: its dimensions are suggested as the parcel", () => {
    assert.deepEqual(suggestPackedDimensions([{ unit: U, quantity: 1 }]), { length: 20, breadth: 15, height: 2 });
  });
  it("more than one unit, several products, or unknown dimensions: NOTHING is suggested", () => {
    assert.equal(suggestPackedDimensions([{ unit: U, quantity: 2 }]), null);
    assert.equal(suggestPackedDimensions([{ unit: U, quantity: 1 }, { unit: U, quantity: 1 }]), null);
    assert.equal(suggestPackedDimensions([{ unit: null, quantity: 1 }]), null);
    assert.equal(suggestPackedDimensions([]), null);
  });
  it("what the operator typed always wins and is never overwritten by a suggestion", () => {
    const typed = { length: "25", breadth: "20", height: "5" };
    assert.deepEqual(resolvePackedDimensions(typed, { length: 20, breadth: 15, height: 2 }), { draft: typed, source: "manual" });
    assert.equal(resolvePackedDimensions(null, { length: 20, breadth: 15, height: 2 }).source, "suggested");
    assert.equal(resolvePackedDimensions(null, null).source, "none");
  });
  it("all three sides are required; each must be a positive number up to 300 cm", () => {
    assert.deepEqual(parseParcelDimensions({ length: "20", breadth: "15", height: "2" }), { ok: true, cm: { length: 20, breadth: 15, height: 2 } });
    assert.deepEqual(parseParcelDimensions({ length: "20", breadth: "", height: "2" }), { ok: false, error: null });
    assert.match((parseParcelDimensions({ length: "0", breadth: "15", height: "2" }) as { error: string }).error, /greater than 0/);
    assert.match((parseParcelDimensions({ length: "20", breadth: "abc", height: "2" }) as { error: string }).error, /must be a number/);
    assert.match((parseParcelDimensions({ length: "20", breadth: "15", height: "301" }) as { error: string }).error, /300 cm or less/);
  });
  it("display and hints distinguish product dimensions from the packed parcel", () => {
    assert.equal(formatDimensions(U), "20 × 15 × 2 cm");
    assert.equal(formatDimensions({ length: 20, breadth: 15, height: 2 }), "20 × 15 × 2 cm");
    assert.match(dimensionsHint("suggested", [{ unit: U, quantity: 1 }]), /Suggested from the product dimensions/);
    assert.match(dimensionsHint("none", [{ unit: U, quantity: 1 }, { unit: U, quantity: 1 }]), /not added up across products/);
    assert.match(dimensionsHint("none", [{ unit: U, quantity: 2 }]), /More than one unit/);
  });
  it("the declared value is the goods value (subtotal minus discount), not shipping", () => {
    assert.equal(goodsValue({ subtotal: "998.00", discountAmount: "100.00" }), 898);
  });
});

const SKU_A: ProductListItem = {
  id: "pa",
  name: "Aayush Wellness Herbal Masala",
  sku: null,
  basePrice: null,
  weightKg: null,
  variants: [
    { id: "v120", name: "Gutka Flavour / 120 - Pouches", sku: "AW-HM-CR-120", price: "499.00", weightKg: "0.25", dimensionsCm: U },
    { id: "v60", name: "Gutka Flavour / 60 - Pouches", sku: "AW-HM-CR-60", price: "299.00", weightKg: "0.12", dimensionsCm: U },
    { id: "vnodim", name: "Gutka Flavour / 180 - Pouches", sku: "AW-HM-CR-180", price: "699.00", weightKg: null, dimensionsCm: null },
  ],
};
const render = (props: Partial<React.ComponentProps<typeof CreateOrderDialog>>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(productListQueryOptions({ page: 1, pageSize: 100 }).queryKey, { items: [SKU_A], pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CreateOrderDialog open onOpenChange={() => {}} leadId="11111111-1111-4111-8111-111111111111" customerName="Vishwa" customerMobile="+919594849404" inline initialOrderType="COD" {...props} />
    </QueryClientProvider>,
  );
};
const field = (h: string, label: string) => new RegExp(`aria-label="${label}"[^>]*value="([^"]*)"|value="([^"]*)"[^>]*aria-label="${label}"`).exec(h)?.slice(1).find((v) => v !== undefined) ?? null;

describe("Create Order (real dialog): SKU -> weights and dimensions", () => {
  it("AW-HM-CR-120 x 1: product weight 0.25, parcel weight 0.25 and the 20 x 15 x 2 dimensions are all filled in automatically", () => {
    const h = render({ initialItems: [{ productId: "pa", variantId: "v120", quantity: "1", unitPrice: "499.00" }] });
    assert.equal(field(h, "Parcel length \\(cm\\)"), "20");
    assert.equal(field(h, "Parcel breadth \\(cm\\)"), "15");
    assert.equal(field(h, "Parcel height \\(cm\\)"), "2");
    const t = text(h);
    assert.match(t, /Suggested from the product dimensions/);
    assert.match(t, /Product dimensions: 20 × 15 × 2 cm \(per unit - not the packed parcel\)/);
    assert.match(t, /Final packed parcel dimensions \(cm\)/);
  });

  it("AW-HM-CR-120 x 2: 0.50 kg product weight and parcel weight, but the packed dimensions are NOT guessed - the operator enters them", () => {
    const h = render({ initialItems: [{ productId: "pa", variantId: "v120", quantity: "2", unitPrice: "499.00" }] });
    const t = text(h);
    assert.match(t, /Product weight: 0\.50 kg \(estimate - not the parcel weight\)/);
    assert.match(h, /id="ship-weight"[^>]*value="0\.5"|value="0\.5"[^>]*id="ship-weight"/);
    assert.match(t, /Suggested from product weights\. Adjust for packaging and actual parcel weight\./);
    assert.equal(field(h, "Parcel length \\(cm\\)"), "");
    assert.match(t, /More than one unit is packed together/);
  });

  it("AW-HM-CR-120 x 2 + AW-HM-CR-60 x 1: 0.50 + 0.12 = 0.62 kg, dimensions left for the operator", () => {
    const h = render({
      initialItems: [
        { productId: "pa", variantId: "v120", quantity: "2", unitPrice: "499.00" },
        { productId: "pa", variantId: "v60", quantity: "1", unitPrice: "299.00" },
      ],
    });
    const t = text(h);
    assert.match(t, /Product weight: 0\.62 kg \(estimate - not the parcel weight\)/);
    assert.match(h, /id="ship-weight"[^>]*value="0\.62"|value="0\.62"[^>]*id="ship-weight"/);
    assert.equal(field(h, "Parcel length \\(cm\\)"), "");
    assert.match(t, /not added up across products/);
  });

  it("typed packed dimensions are kept (shown as entered) and labelled as the final parcel size", () => {
    const h = render({ initialItems: [{ productId: "pa", variantId: "v120", quantity: "1", unitPrice: "499.00" }], initialDimensions: { length: "25", breadth: "18", height: "4" } });
    assert.equal(field(h, "Parcel length \\(cm\\)"), "25");
    assert.equal(field(h, "Parcel height \\(cm\\)"), "4");
    assert.match(text(h), /Final packed parcel dimensions — sent to Shiprocket as entered\./);
  });

  it("a SKU without recorded weight or dimensions: nothing is invented", () => {
    const h = render({ initialItems: [{ productId: "pa", variantId: "vnodim", quantity: "1", unitPrice: "699.00" }] });
    const t = text(h);
    assert.match(t, /Parcel weight not available — enter the actual parcel weight\./);
    assert.match(t, /Product dimensions not recorded — enter the final packed parcel size\./);
    assert.equal(field(h, "Parcel length \\(cm\\)"), "");
  });
});

describe("Shiprocket catalog import UI", () => {
  const job = (over: Partial<CatalogImportStatus> = {}): CatalogImportStatus => ({
    id: "j1",
    fileName: "shiprocket_catalog.csv",
    status: "running",
    total: 8400,
    processed: 6048,
    summary: { total: 6048, imported: 0, updated: 0, unchanged: 0, skipped: 0, unmatched: 0, errors: 0 },
    failedRowCount: 0,
    failedRowsPreview: [],
    error: null,
    ...over,
  });

  it("progress: file name, total, a progress bar at 72% and '6,048 / 8,400 SKUs'", () => {
    assert.equal(importPercent(job()), 72);
    assert.equal(progressLabel(job()), "6,048 / 8,400 SKUs");
    const t = text(renderToStaticMarkup(<CatalogImportProgress job={job()} />));
    assert.match(t, /File: shiprocket_catalog\.csv — 8,400 SKUs/);
    assert.match(t, /Importing Shiprocket Catalog\.\.\./);
    assert.match(t, /72% · 6,048 \/ 8,400 SKUs/);
    assert.doesNotMatch(t, /Import complete/);
  });

  it("complete: the summary (total, imported, updated, unchanged, skipped, unmatched, errors) and the failed-row report", () => {
    const done = job({
      status: "completed",
      processed: 8400,
      summary: { total: 8400, imported: 8000, updated: 120, unchanged: 180, skipped: 50, unmatched: 25, errors: 25 },
      failedRowCount: 100,
      failedRowsPreview: [{ row: 5, sku: "8.00994E+12", name: "Tea", status: "error", reason: "SKU looks like scientific notation" }],
    });
    assert.equal(importPercent(done), 100);
    const h = renderToStaticMarkup(<CatalogImportProgress job={done} onDownloadFailed={() => {}} />);
    const t = text(h);
    assert.match(t, /Import complete/);
    for (const [label, n] of [["Total rows", "8,400"], ["Imported", "8,000"], ["Updated", "120"], ["Unchanged", "180"], ["Skipped", "50"], ["Unmatched", "25"], ["Errors", "25"]]) {
      assert.match(t, new RegExp(`${label} ${n}`));
    }
    assert.match(t, /100 rows were not imported/);
    assert.match(t, /Download failed rows/);
    assert.match(t, /Row 5 8\.00994E\+12 error SKU looks like scientific notation/);
  });

  it("a failed import says so and that re-uploading is safe", () => {
    const t = text(renderToStaticMarkup(<CatalogImportProgress job={job({ status: "failed", error: "database unavailable" })} />));
    assert.match(t, /Import failed: database unavailable\. It is safe to upload the file again\./);
  });
});

import { isDimensionDraftEmpty, rateInputsOrMissing, rateKey } from "@/lib/package-dimensions";
describe("rates need no dimensions: with none entered Shiprocket is asked about the weight alone", () => {
  const base = { pincodeValid: true, pincode: "400017", cod: true, weight: { ok: true as const, kg: 0.24 }, value: 1198 };
  it("no dimensions at all -> a request is made, carrying no dimensions", () => {
    const empty = { length: "", breadth: "", height: "" };
    assert.ok(isDimensionDraftEmpty(empty));
    const r = rateInputsOrMissing({ ...base, dims: parseParcelDimensions(empty), dimsEmpty: true });
    assert.ok(r.ok);
    assert.equal(r.inputs.dims, null);
  });
  it("half-typed or invalid dimensions wait for the operator (nothing is requested)", () => {
    const half = { length: "20", breadth: "", height: "" };
    assert.deepEqual(rateInputsOrMissing({ ...base, dims: parseParcelDimensions(half), dimsEmpty: isDimensionDraftEmpty(half) }), { ok: false, missing: "dimensions" });
  });
  it("entering dimensions later is a different request (the rates are refreshed)", () => {
    const none = rateInputsOrMissing({ ...base, dims: parseParcelDimensions({ length: "", breadth: "", height: "" }), dimsEmpty: true });
    const some = rateInputsOrMissing({ ...base, dims: parseParcelDimensions({ length: "20", breadth: "15", height: "4" }) });
    assert.ok(none.ok && some.ok);
    assert.notEqual(rateKey(none.inputs), rateKey(some.inputs));
  });
});
