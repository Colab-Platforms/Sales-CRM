"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

// Shopify's Relay-style cursors have no cheap "total pages" concept, so this is Prev/Next only -
// not a drop-in replacement for OrdersPagination's page-number UI.
interface OrdersCursorPaginationProps {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  onNext: () => void;
  onPrevious: () => void;
  disabled?: boolean;
  /** When both are given, a rows-per-page selector (20 / 50 / 100) is shown. */
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
}

export const ORDER_PAGE_SIZES = [20, 50, 100] as const;

export function OrdersCursorPagination({
  hasNextPage,
  hasPreviousPage,
  onNext,
  onPrevious,
  disabled,
  pageSize,
  onPageSizeChange,
}: OrdersCursorPaginationProps) {
  const sizeSelector = pageSize !== undefined && onPageSizeChange;
  if (!hasNextPage && !hasPreviousPage && !sizeSelector) return null;

  return (
    <nav aria-label="Orders pagination" className="flex flex-wrap items-center justify-end gap-2 pt-4">
      {sizeSelector ? (
        <>
          <label htmlFor="orders-page-size" className="text-sm text-muted-foreground">
            Rows per page
          </label>
          <select
            id="orders-page-size"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            disabled={disabled}
            className="h-8 rounded-md border bg-background px-2 text-sm"
          >
            {ORDER_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </>
      ) : null}
      <Button variant="outline" size="sm" disabled={disabled || !hasPreviousPage} onClick={onPrevious}>
        <ChevronLeft data-icon="inline-start" />
        Previous
      </Button>
      <Button variant="outline" size="sm" disabled={disabled || !hasNextPage} onClick={onNext}>
        Next
        <ChevronRight data-icon="inline-end" />
      </Button>
    </nav>
  );
}
