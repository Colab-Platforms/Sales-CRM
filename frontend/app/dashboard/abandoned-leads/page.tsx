"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ShoppingCart } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { getErrorMessage } from "@/lib/api-client/client";
import { abandonmentListQueryOptions } from "@/lib/api-client/queries/abandonment.queries";
import { AbandonmentFilters, type AbandonmentFilterState } from "@/components/abandonment/abandonment-filters";
import { AbandonmentSummaryCards } from "@/components/abandonment/abandonment-summary-cards";
import { AbandonmentTable, AbandonmentTableSkeleton } from "@/components/abandonment/abandonment-table";
import { AbandonmentDetailSheet } from "@/components/abandonment/abandonment-detail-sheet";
import { OrdersPagination } from "@/components/orders/orders-pagination";

const PAGE_SIZE = 20;

export default function AbandonedLeadsPage() {
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<AbandonmentFilterState>({});
  const [openId, setOpenId] = useState<string | null>(null);

  const params = useMemo(() => ({ page, pageSize: PAGE_SIZE, ...filters }), [page, filters]);
  const { data, isPending, isFetching, error } = useQuery(abandonmentListQueryOptions(params));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Abandoned Leads"
        description="Shoppers who entered checkout on the website but left before paying, via Shiprocket Checkout. Reach out while the intent is still fresh."
      />

      {data ? <AbandonmentSummaryCards summary={data.summary} /> : null}

      <AbandonmentFilters
        value={filters}
        onChange={(next) => {
          setFilters(next);
          setPage(1);
        }}
      />

      {error ? (
        <div className="sketch-outline border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {getErrorMessage(error, "Failed to load abandoned leads.")}
        </div>
      ) : (
        <Card>
          <CardContent>
            {isPending ? (
              <AbandonmentTableSkeleton />
            ) : data && data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                  <ShoppingCart className="size-5" />
                </div>
                <p className="text-sm font-medium">No abandoned carts right now.</p>
                <p className="text-sm text-muted-foreground">
                  New entries appear here automatically as shoppers leave checkout without paying.
                </p>
              </div>
            ) : (
              <>
                <AbandonmentTable items={data?.items ?? []} isFetching={isFetching} onOpenDetail={setOpenId} />
                {data ? <OrdersPagination pagination={data.pagination} onPageChange={setPage} disabled={isFetching} /> : null}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <AbandonmentDetailSheet abandonmentId={openId} onOpenChange={setOpenId} />
    </div>
  );
}
