import { LeadDetailView } from "@/components/leads/lead-detail-view";

// Typed manually (not via the generated PageProps<"/dashboard/leads/[leadId]"> helper): the typed-route
// manifest for this new route isn't generated yet, which is what makes that helper fail to typecheck for
// the other dynamic routes in this app too (see orders/[id], customers/[leadId]) until a build/dev run
// regenerates it. This still awaits `params` the same way Next expects.
export default async function LeadDetailPage({ params }: { params: Promise<{ leadId: string }> }) {
  const { leadId } = await params;
  return <LeadDetailView leadId={leadId} />;
}
