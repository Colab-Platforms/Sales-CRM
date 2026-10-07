import { OrderDetailView } from "@/components/orders/order-detail-view";
import { LiveOrderDetailView } from "@/components/orders/live-order-detail-view";
import { parseLiveOrderId } from "@/lib/api-client/types/orders.types";

export default async function OrderDetailPage(props: PageProps<"/dashboard/orders/[id]">) {
  const { id } = await props.params;
  // A Shopify order not yet synced into the CRM has an id of the form "shopify:<externalId>" (see
  // orders.live.service.ts's mapUnlinked and orders-table.tsx's orderDetailHref) - there is no CRM
  // order to fetch by that id, so it's routed to the live-Shopify-only detail view instead.
  const liveExternalId = parseLiveOrderId(id);
  if (liveExternalId) return <LiveOrderDetailView externalId={liveExternalId} />;
  return <OrderDetailView id={id} />;
}
