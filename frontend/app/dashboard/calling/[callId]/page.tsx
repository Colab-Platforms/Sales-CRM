import { CallDetailView } from "@/components/calling/call-detail-view";

// Typed manually rather than via the generated PageProps<...> helper, matching
// app/dashboard/leads/[leadId]/page.tsx — see that file's comment for why.
export default async function CallDetailPage({ params }: { params: Promise<{ callId: string }> }) {
  const { callId } = await params;
  return <CallDetailView callId={callId} />;
}
