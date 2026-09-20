import { WhatsAppCampaignDetailView } from "@/components/whatsapp/campaigns/whatsapp-campaign-detail-view";

export default async function WhatsAppCampaignDetailPage(props: PageProps<"/dashboard/whatsapp/campaigns/[id]">) {
  const { id } = await props.params;
  return <WhatsAppCampaignDetailView id={id} />;
}
