import { useEffect, useState } from "react";

/** The current time in ms, refreshed every `intervalMs`, so time-based UI (overdue, "in 4 min") stays current. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
