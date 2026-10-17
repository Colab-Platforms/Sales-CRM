import { redirect } from "next/navigation";

// Sales & Revenue now lives in the Reports page's Sales section; keep old links and bookmarks working.
export default function SalesRevenueMovedPage() {
  redirect("/dashboard/reports");
}
