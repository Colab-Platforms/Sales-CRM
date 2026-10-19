import { JobApplicationsView } from "@/components/recruitment/job-applications-view";

export default async function JobDetailPage(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <JobApplicationsView jobId={id} />;
}
