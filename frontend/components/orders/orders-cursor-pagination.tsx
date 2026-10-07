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
}

export function OrdersCursorPagination({
  hasNextPage,
  hasPreviousPage,
  onNext,
  onPrevious,
  disabled,
}: OrdersCursorPaginationProps) {
  if (!hasNextPage && !hasPreviousPage) return null;

  return (
    <nav aria-label="Orders pagination" className="flex items-center justify-end gap-2 pt-4">
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
