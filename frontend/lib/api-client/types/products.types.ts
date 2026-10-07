// Kept in sync with backend/src/modules/products/products.types.ts.
export interface ListProductsParams {
  page: number;
  pageSize: number;
  search?: string;
}

/** Recorded per-unit PRODUCT dimensions (cm); null unless all three sides are recorded. Not the packed parcel size. */
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
  /** Recorded weight of one unit (kg); null = not recorded. Informational only. */
  weightKg?: string | null;
  dimensionsCm?: UnitDimensionsCm | null;
}

export interface ProductListItem {
  id: string;
  name: string;
  sku: string | null;
  basePrice: string | null;
  /** Recorded weight of one unit (kg) for a product sold without variants; null = not recorded. */
  weightKg?: string | null;
  dimensionsCm?: UnitDimensionsCm | null;
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

export interface CatalogImportSummary {
  total: number;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  unmatched: number;
  errors: number;
}

export interface CatalogImportFailedRow {
  row: number;
  sku: string | null;
  name: string | null;
  status: "skipped" | "unmatched" | "error";
  reason: string;
}

export interface CatalogImportStatus {
  id: string;
  fileName: string;
  status: "running" | "completed" | "failed";
  total: number;
  processed: number;
  summary: CatalogImportSummary;
  failedRowCount: number;
  /** More rows failed than the report keeps (the first 50,000 are kept); the summary counts are always complete. */
  failedRowsTruncated?: boolean;
  failedRowsPreview: CatalogImportFailedRow[];
  error: string | null;
}
