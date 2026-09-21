import { OrderDetailView } from "@/components/orders/order-detail-view";

export default async function OrderDetailPage(props: PageProps<"/dashboard/orders/[id]">) {
  const { id } = await props.params;
  return <OrderDetailView id={id} />;
}
