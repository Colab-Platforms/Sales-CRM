// Kept in sync with backend/src/modules/products/products.types.ts.
export interface ListProductsParams {
  page: number;
  pageSize: number;
  search?: string;
}

export interface ProductVariantOption {
  id: string;
  name: string;
  sku: string | null;
  price: string | null;
}

export interface ProductListItem {
  id: string;
  name: string;
  sku: string | null;
  basePrice: string | null;
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
