import { LeadDetailView } from "@/components/leads/lead-detail-view";

export default async function LeadDetailPage(props: PageProps<"/dashboard/leads/[leadId]">) {
  const { leadId } = await props.params;
  return <LeadDetailView leadId={leadId} />;
}
