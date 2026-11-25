// Link into the Call Recordings page for one lead ("View Recordings" on the Abandoned Leads table). The whole history is searched (not just the last 30 days), so every
// recording of the lead is there. The page re-validates the URL and the server re-checks the viewer's scope.

const istDay = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

export function callRecordingsHref(leadId: string): string {
  const q = new URLSearchParams({ leadId, from: "2020-01-01", to: istDay() });
  return `/dashboard/abandoned-leads/call-recordings?${q.toString()}`;
}
