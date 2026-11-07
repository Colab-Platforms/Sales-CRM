"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// The admin incentive page moved to /admin/sales-incentives; keep old links working.
export default function IncentivesRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin/sales-incentives");
  }, [router]);
  return null;
}
