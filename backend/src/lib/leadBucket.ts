/** Daily work bucket helpers. A bucket day is an IST calendar date, stored in a `@db.Date` column (UTC midnight of that date). */
const BUCKET_TIME_ZONE = "Asia/Kolkata";

export function bucketToday(now: Date = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: BUCKET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${ymd}T00:00:00.000Z`);
}
