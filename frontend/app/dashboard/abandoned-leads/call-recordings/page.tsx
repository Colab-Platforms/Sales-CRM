import { Suspense } from "react";
import { CallRecordingsView } from "@/components/call-recordings/call-recordings-view";
import { Skeleton } from "@/components/ui/skeleton";

export default function CallRecordingsPage() {
  // CallRecordingsView reads the URL's search params (a lead filter from "View Recordings"), which requires a Suspense boundary.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <CallRecordingsView />
    </Suspense>
  );
}
