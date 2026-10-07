// Minimal, read-only product-catalog listing - added only because the manual "Create Order" flow
// (E7.8) needs some way to list what a line item can reference, and nothing in the repo already did
// this. Reuses the existing Product/ProductVariant models as-is; adds no fields, no schema change.
export interface ListProductsQuery {
  page: number;
  pageSize: number;
  search?: string;
}

export interface UnitDimensionsCm {
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

export interface UnitDimensionsCm {
  lengthCm: string;
  widthCm: string;
  heightCm: string;
}

export interface ProductVariantOption {
  id: string;
  name: string;
  sku: string | null;
  price: string | null;
  /** Weight of one unit (kg) as recorded by a person; null = not recorded. Informational - never the parcel weight. */
  weightKg: string | null;
  /** Per-unit product dimensions (cm) from the Shiprocket catalog; null unless all three sides are recorded. NOT the packed parcel dimensions. */
  dimensionsCm: UnitDimensionsCm | null;
}

export interface ProductListItem {
  id: string;
  name: string;
  sku: string | null;
  basePrice: string | null;
  /** Weight of one unit (kg) for a product sold without variants; null = not recorded. */
  weightKg: string | null;
  dimensionsCm: UnitDimensionsCm | null;
  variants: ProductVariantOption[];
}

export interface Pagination {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface ProductListResult {
  items: ProductListItem[];
  pagination: Pagination;
}
