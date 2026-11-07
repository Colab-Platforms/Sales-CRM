// The "Tracking" block of the order detail: one read-only view built ONLY from data the CRM already holds - the shipment rows (kept current by the Shiprocket webhook / Shopify fulfilment sync)
// and, when the shipment has an AWB, Shiprocket's live scan list. Nothing here calls a provider, creates an AWB / courier / shipment, or writes anything. Events are never invented: a timeline
// row exists only because a scan or a recorded timestamp says so.

export type TrackingStage =
  | "ORDER_CONFIRMED"
  | "SHIPMENT_CREATED"
  | "AWB_ASSIGNED"
  | "PICKUP_SCHEDULED"
  | "PICKED_UP"
  | "IN_TRANSIT"
  | "REACHED_DESTINATION_HUB"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED"
  | "DELIVERY_FAILED"
  | "RTO_INITIATED"
  | "RTO_DELIVERED"
  | "CANCELLED"
  | "OTHER";

export const STAGE_LABEL: Record<TrackingStage, string> = {
  ORDER_CONFIRMED: "Order confirmed",
  SHIPMENT_CREATED: "Shipment created",
  AWB_ASSIGNED: "AWB assigned",
  PICKUP_SCHEDULED: "Pickup scheduled",
  PICKED_UP: "Picked up",
  IN_TRANSIT: "In transit",
  REACHED_DESTINATION_HUB: "Reached destination hub",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  DELIVERY_FAILED: "Delivery failed / NDR",
  RTO_INITIATED: "RTO initiated",
  RTO_DELIVERED: "Returned to origin",
  CANCELLED: "Shipment cancelled",
  OTHER: "Update",
};

const norm = (t: string) => t.toUpperCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

/** One mapping for every source (a live scan, the webhook's stored text): Shiprocket's wording -> a stage. Unknown wording is OTHER and keeps its own text. */
export function stageOf(text: string | null | undefined): TrackingStage {
  if (!text) return "OTHER";
  const t = norm(text);
  if (/^RTO\b|\bRTO (INITIATED|IN TRANSIT|OFD|NDR)\b|RETURN(ED)? (TO ORIGIN|INITIATED)|RETURN IN TRANSIT/.test(t)) return /DELIVERED|ACKNOWLEDGED/.test(t) ? "RTO_DELIVERED" : "RTO_INITIATED";
  if (/UNDELIVERED|NDR|DELIVERY ATTEMPT(ED)? FAILED|DELIVERY FAILED|CONSIGNEE (UNAVAILABLE|REFUSED)|DELIVERY EXCEPTION/.test(t)) return "DELIVERY_FAILED";
  if (/OUT FOR DELIVERY/.test(t)) return "OUT_FOR_DELIVERY";
  if (/\bDELIVERED\b/.test(t)) return "DELIVERED";
  if (/REACHED AT DESTINATION|DESTINATION HUB|REACHED (AT )?DESTINATION/.test(t)) return "REACHED_DESTINATION_HUB";
  if (/^(SHIPPED|DISPATCHED)$/.test(t)) return "PICKED_UP";
  if (/IN TRANSIT/.test(t)) return "IN_TRANSIT";
  if (/PICKED UP|PICKUP DONE|PICKED/.test(t) && !/PICKUP (SCHEDULED|GENERATED|QUEUED|RESCHEDULED|EXCEPTION|ERROR)/.test(t)) return "PICKED_UP";
  if (/PICKUP (SCHEDULED|GENERATED|QUEUED|RESCHEDULED)|OUT FOR PICKUP/.test(t)) return "PICKUP_SCHEDULED";
  if (/AWB ASSIGNED|READY TO SHIP/.test(t)) return "AWB_ASSIGNED";
  if (/^NEW$|ORDER (CREATED|PLACED)|SHIPMENT CREATED/.test(t)) return "SHIPMENT_CREATED";
  if (/CANCEL/.test(t)) return "CANCELLED";
  return "OTHER";
}

/** "2023-05-23 11:43:52" (no zone) is India Standard Time, the same reading the webhook uses. Anything unreadable is null - never a guess. */
export function parseProviderDate(value: string | null | undefined): Date | null {
  const text = value?.trim();
  if (!text) return null;
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? text : `${text.replace(" ", "T")}+05:30`;
  const d = new Date(withZone);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface TrackingEvent {
  /** ISO time, or null when the provider gave none that could be read. */
  at: string | null;
  stage: TrackingStage;
  /** Our label for the stage; for an unmapped status the provider's own words. */
  label: string;
  /** The provider's own wording for this event, when different from the label. */
  detail: string | null;
  location: string | null;
  source: "SHIPROCKET" | "CRM";
}

export interface ShipmentTracking {
  shipmentId: string;
  courier: string | null;
  awb: string | null;
  shiprocketOrderId: string | null;
  /** The provider's public tracking page - safe to send to a customer. Null when neither the shipment nor the provider supplied one. */
  trackingUrl: string | null;
  createdAt: string;
  status: { stage: TrackingStage; label: string; providerText: string | null };
  latestUpdateAt: string | null;
  /** Only when the provider supplied one, and not once delivered / returned / cancelled. */
  estimatedDelivery: string | null;
  /** "live": Shiprocket's scans are shown; "unavailable": Shiprocket could not be read, so the timeline is the CRM's recorded data only; "none": no AWB to look up. */
  live: "live" | "unavailable" | "none";
  liveError: string | null;
  events: TrackingEvent[];
}

export interface OrderTracking {
  /** NOT_CREATED: no shipment row at all. */
  state: "NOT_CREATED" | "SHIPMENT";
  headline: string;
  shipments: ShipmentTracking[];
  /** Order-level event (confirmed) shown ahead of any shipment. */
  orderEvents: TrackingEvent[];
}

export interface TrackingShipmentInput {
  id: string;
  status: string;
  courier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  expectedDeliveryAt: Date | null;
  deliveredAt: Date | null;
  returnedAt: Date | null;
  createdAt: Date;
  pickupScheduledAt: Date | null;
  providerStatus: string | null;
  shiprocketOrderId: string | null;
  liveTracking?: { tracking: { currentStatus: string | null; trackUrl: string | null; etd: string | null; courierName: string | null; activities: { date: string | null; status: string | null; location: string | null }[] } | null; error?: string } | undefined;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const safeUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u.trim()) ? u.trim() : null);

// CRM status (ShipmentStatus) when the provider gave no wording at all.
const CRM_STATUS_STAGE: Record<string, TrackingStage> = {
  CREATED: "SHIPMENT_CREATED",
  AWB_ASSIGNED: "AWB_ASSIGNED",
  PICKUP_SCHEDULED: "PICKUP_SCHEDULED",
  SHIPPED: "PICKED_UP",
  IN_TRANSIT: "IN_TRANSIT",
  OUT_FOR_DELIVERY: "OUT_FOR_DELIVERY",
  DELIVERED: "DELIVERED",
  RETURNED: "RTO_DELIVERED",
  CANCELLED: "CANCELLED",
};

function buildShipment(s: TrackingShipmentInput): ShipmentTracking {
  const live = s.liveTracking;
  const scans = live?.tracking?.activities ?? [];
  const events: TrackingEvent[] = [];

  for (const a of scans) {
    const stage = stageOf(a.status);
    events.push({ at: iso(parseProviderDate(a.date)), stage, label: stage === "OTHER" ? (a.status ?? STAGE_LABEL.OTHER) : STAGE_LABEL[stage], detail: stage === "OTHER" ? null : a.status, location: a.location, source: "SHIPROCKET" });
  }
  const has = (stage: TrackingStage) => events.some((e) => e.stage === stage);
  const crm = (stage: TrackingStage, at: Date | null) => {
    if (at && !has(stage)) events.push({ at: at.toISOString(), stage, label: STAGE_LABEL[stage], detail: null, location: null, source: "CRM" });
  };
  // The shipment's own recorded times (kept current by the Shiprocket webhook / Shopify fulfilment) fill in only what the scans do not already say.
  crm("PICKUP_SCHEDULED", s.pickupScheduledAt);
  crm("PICKED_UP", s.shippedAt);
  crm("DELIVERED", s.deliveredAt);
  crm("RTO_DELIVERED", s.returnedAt);
  // The row's creation time is when the CRM recorded the shipment (for a Shopify-synced one, when it synced). It is shown as "Shipment created" only when it does not come after something that really happened.
  const firstReal = events.map((e) => e.at).filter((a): a is string => a !== null).sort()[0];
  if (!firstReal || s.createdAt.toISOString() <= firstReal) crm("SHIPMENT_CREATED", s.createdAt);

  events.sort((a, b) => {
    if (a.at === null && b.at === null) return 0;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at.localeCompare(b.at);
  });

  // Current status: the provider's own newest wording (live current status, else the webhook's stored text), else the CRM status. The newest dated event is "latest update".
  const providerText = live?.tracking?.currentStatus ?? s.providerStatus ?? null;
  const stage: TrackingStage = providerText ? stageOf(providerText) : (CRM_STATUS_STAGE[s.status] ?? "OTHER");
  const fallbackStage = stage;
  const dated = events.filter((e) => e.at);
  const done = fallbackStage === "DELIVERED" || fallbackStage === "RTO_DELIVERED" || fallbackStage === "CANCELLED" || s.status === "DELIVERED" || s.status === "RETURNED" || s.status === "CANCELLED";
  const etd = parseProviderDate(live?.tracking?.etd) ?? s.expectedDeliveryAt;

  return {
    shipmentId: s.id,
    courier: s.courier ?? live?.tracking?.courierName ?? null,
    awb: s.trackingNumber,
    shiprocketOrderId: s.shiprocketOrderId,
    trackingUrl: safeUrl(s.trackingUrl) ?? safeUrl(live?.tracking?.trackUrl),
    createdAt: s.createdAt.toISOString(),
    status: { stage: fallbackStage, label: fallbackStage === "OTHER" && providerText ? providerText : STAGE_LABEL[fallbackStage], providerText },
    latestUpdateAt: dated.length > 0 ? dated[dated.length - 1]!.at : null,
    estimatedDelivery: !done && etd ? etd.toISOString() : null,
    live: !s.trackingNumber ? "none" : live?.tracking ? "live" : "unavailable",
    liveError: s.trackingNumber && !live?.tracking ? (live?.error ?? "Shiprocket has no tracking for this AWB yet") : null,
    events,
  };
}

export function buildOrderTracking(input: { confirmedAt: Date | null; shipments: TrackingShipmentInput[] }): OrderTracking {
  const orderEvents: TrackingEvent[] = input.confirmedAt ? [{ at: input.confirmedAt.toISOString(), stage: "ORDER_CONFIRMED", label: STAGE_LABEL.ORDER_CONFIRMED, detail: null, location: null, source: "CRM" }] : [];
  if (input.shipments.length === 0) return { state: "NOT_CREATED", headline: "Shipment not created yet", shipments: [], orderEvents };
  const shipments = input.shipments.map(buildShipment);
  const first = shipments[0]!;
  const headline = !first.awb && first.status.stage === "SHIPMENT_CREATED" ? "Shipment created - AWB not assigned yet" : first.status.label;
  return { state: "SHIPMENT", headline, shipments, orderEvents };
}
