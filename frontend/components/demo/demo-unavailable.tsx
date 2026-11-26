import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { DEMO_UNAVAILABLE_MESSAGE } from "@/lib/demo";

/** Shown in place of any screen the demo does not cover, so no demo path ends in an error page. */
export function DemoUnavailable() {
  return (
    <div role="status" data-testid="demo-unavailable" className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <FlaskConical className="size-8 text-amber-600" aria-hidden />
      <h1 className="text-xl font-semibold">Not part of the demo</h1>
      <p className="text-sm text-muted-foreground">{DEMO_UNAVAILABLE_MESSAGE}</p>
      <Link href="/dashboard" className="text-sm font-medium underline underline-offset-4">
        Back to the dashboard
      </Link>
    </div>
  );
}
