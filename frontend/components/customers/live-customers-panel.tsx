"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { OrdersCursorPagination } from "@/components/orders/orders-cursor-pagination";
import { useLiveCustomers } from "@/hooks/useCustomers";
import { CustomersLiveTable, CustomersLiveTableSkeleton } from "./customers-live-table";

const PAGE_SIZE = 25;

// A separate, additive "Live from Shopify" view alongside the main CRM-DB-backed Customers list
// (customers-list-view.tsx, untouched) - toggled on from there. Self-contained state (own search +
// cursor stack) rather than folded into the main page's URL/filter state, since the two data sources
// support different filters (this one: search only - see customers.live.service.ts).
export function LiveCustomersPanel() {
  const [searchText, setSearchText] = useState("");
  const [afterStack, setAfterStack] = useState<string[]>([]);
  const currentAfter = afterStack.length > 0 ? afterStack[afterStack.length - 1] : undefined;

  const { data, isLoading, isFetching, error, refetch } = useLiveCustomers({
    after: currentAfter,
    first: PAGE_SIZE,
    search: searchText.trim() || undefined,
  });

  const handleSearchChange = (text: string) => {
    setSearchText(text);
    setAfterStack([]);
  };

  const handleNext = () => {
    if (data?.pageInfo.endCursor) setAfterStack((stack) => [...stack, data.pageInfo.endCursor!]);
  };
  const handlePrevious = () => setAfterStack((stack) => stack.slice(0, -1));

  const loadError = error ?? data?.error ?? null;

  let content;
  if (isLoading) {
    content = <CustomersLiveTableSkeleton />;
  } else if (loadError && (!data || data.items.length === 0)) {
    content = (
      <div role="alert" className="flex flex-col items-center gap-3 py-12 text-center">
        <p className="text-sm text-destructive">{loadError}</p>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  } else if (data && data.items.length === 0) {
    content = (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {searchText.trim() ? "No Shopify customers match your search." : "No Shopify customers found."}
      </div>
    );
  } else if (data) {
    content = (
      <>
        {data.partialError ? (
          <p role="alert" className="pb-3 text-sm text-destructive">
            {data.partialError}
          </p>
        ) : null}
        <CustomersLiveTable items={data.items} isFetching={isFetching} />
        <OrdersCursorPagination
          hasNextPage={data.pageInfo.hasNextPage}
          hasPreviousPage={afterStack.length > 0}
          onNext={handleNext}
          onPrevious={handlePrevious}
          disabled={isFetching}
        />
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          value={searchText}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search Shopify customers by name, email or phone"
          aria-label="Search live Shopify customers"
          maxLength={100}
          className="pl-8"
        />
      </div>
      <Card>
        <CardContent>{content}</CardContent>
      </Card>
    </div>
  );
}
