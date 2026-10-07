"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getErrorMessage } from "@/lib/api-client/client";
import { productsApi } from "@/lib/api-client/endpoints/products.api";
import { productListQueryOptions, productsKeys } from "@/lib/api-client/queries/products.queries";
import { useAuthStore } from "@/stores/auth-store";
import { parseParcelWeight } from "@/lib/parcel-weight";
import { formatDimensions } from "@/lib/package-dimensions";
import type { UnitDimensionsCm } from "@/lib/api-client/types/products.types";
import { CatalogImportPanel } from "./catalog-import-panel";

interface RowTarget {
  kind: "product" | "variant";
  id: string;
}

/** One sellable unit (a variant, or a product sold without variants) and its recorded weight. Blank = not recorded; nothing is defaulted. */
function WeightRow({ target, label, sku, weightKg, dimensionsCm }: { target: RowTarget; label: string; sku: string | null; weightKg: string | null | undefined; dimensionsCm?: UnitDimensionsCm | null }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState<string | null>(null);
  const current = weightKg ?? "";
  const value = text ?? current;
  const parsed = parseParcelWeight(value);
  const dirty = value.trim() !== current;
  const save = useMutation({
    mutationFn: (kg: number | null) => productsApi.setWeight(target, kg),
    onSuccess: () => {
      setText(null);
      queryClient.invalidateQueries({ queryKey: productsKeys.all });
      toast.success("Weight saved.");
    },
    onError: (error) => toast.error(getErrorMessage(error, "Could not save the weight.")),
  });
  const canSave = dirty && (value.trim() === "" || parsed.ok) && !save.isPending;

  return (
    <div className="grid items-center gap-2 border-t px-4 py-2 sm:grid-cols-[1fr_220px_auto]">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">
          SKU {sku ?? "—"}
          {dimensionsCm ? ` · ${formatDimensions(dimensionsCm)}` : ""}
        </p>
      </div>
      <div className="grid gap-1">
        <div className="flex items-center gap-2">
          <Input aria-label={`Weight in kg for ${label}`} inputMode="decimal" placeholder="Not recorded" value={value} onChange={(e) => setText(e.target.value)} aria-invalid={!parsed.ok && Boolean(parsed.error)} className="h-8" />
          <span className="text-sm text-muted-foreground">kg</span>
        </div>
        {!parsed.ok && parsed.error ? <p role="alert" className="text-xs text-destructive">{parsed.error}</p> : null}
      </div>
      <Button type="button" size="sm" disabled={!canSave} onClick={() => save.mutate(value.trim() === "" ? null : parsed.ok ? parsed.kg : null)}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}

// ADMIN / MANAGER: record the real weight of each sellable unit (pack sizes differ). Informational - it is shown on Create Order but is never
// used as the parcel weight, which is entered for the packed parcel when checking couriers / creating a shipment.
export function ProductWeightsView() {
  const role = useAuthStore((s) => s.user?.role);
  const [search, setSearch] = useState("");
  const { data, isPending, error } = useQuery(productListQueryOptions({ page: 1, pageSize: 100, search: search.trim() || undefined }));

  if (role && role !== "ADMIN" && role !== "MANAGER") {
    return <p className="text-sm text-muted-foreground">Only admins and managers can record product weights.</p>;
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Product Weights" description="Weight and dimensions of each product or pack size - import them from the Shiprocket catalog or record a weight by hand. Blank means not recorded; nothing is assumed. The parcel weight and size for shipping are confirmed for the packed parcel." />
      <CatalogImportPanel />
      <Input aria-label="Search products" placeholder="Search by name or SKU" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
      {error ? <p role="alert" className="text-sm text-destructive">{getErrorMessage(error, "Could not load products.")}</p> : null}
      <Card>
        <CardContent className="p-0">
          {isPending ? <p className="p-4 text-sm text-muted-foreground">Loading products…</p> : null}
          {data && data.items.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No products found.</p> : null}
          {data?.items.map((p) => (
            <div key={p.id}>
              <p className="bg-muted/40 px-4 py-2 text-sm font-semibold">{p.name}</p>
              {p.variants.length === 0 ? (
                <WeightRow key={`${p.id}:${p.weightKg ?? ""}`} target={{ kind: "product", id: p.id }} label={p.name} sku={p.sku} weightKg={p.weightKg} dimensionsCm={p.dimensionsCm} />
              ) : (
                p.variants.map((v) => <WeightRow key={`${v.id}:${v.weightKg ?? ""}`} target={{ kind: "variant", id: v.id }} label={v.name} sku={v.sku} weightKg={v.weightKg} dimensionsCm={v.dimensionsCm} />)
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
