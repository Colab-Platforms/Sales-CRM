import { Customer360View } from "@/components/customers/customer-360-view";

export default async function CustomerDetailPage(props: PageProps<"/dashboard/customers/[leadId]">) {
  const { leadId } = await props.params;
  return <Customer360View leadId={leadId} />;
}
