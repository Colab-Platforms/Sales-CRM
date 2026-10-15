import { ApplicationDetailView } from "@/components/recruitment/application-detail-view";

export default async function ApplicationDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <ApplicationDetailView applicationId={id} />;
}
