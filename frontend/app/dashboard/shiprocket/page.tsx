import { Suspense } from "react";
import { ShiprocketListView } from "@/components/shiprocket/shiprocket-list-view";
import { ShiprocketTableSkeleton } from "@/components/shiprocket/shiprocket-table";

export default function ShiprocketPage() {
  // ShiprocketListView reads the URL's search params, which requires a Suspense boundary.
  return (
    <Suspense fallback={<ShiprocketTableSkeleton />}>
      <ShiprocketListView />
    </Suspense>
  );
}
