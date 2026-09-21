import { asRecord, asString, ProviderHttpError, requestJson } from "../integrations/integrations.common.js";
import type { ShiprocketConfig } from "./shiprocket.config.js";
import { ShiprocketTokenProvider, sharedTokenProvider } from "./shiprocket.token.js";

// The only place that talks to Shiprocket. Endpoints are from Shiprocket's API helpsheet:
//   POST /orders/create/adhoc          create an order      -> order_id, shipment_id
//   GET  /courier/serviceability/      available couriers   (order_id, or pickup/delivery postcode + weight + cod)
//   POST /courier/assign/awb           {shipment_id, courier_id} -> awb_code, courier_name
//   POST /courier/generate/pickup      {shipment_id: [..]}
//   POST /courier/generate/label       {shipment_id: [..]}   -> label_url
//   GET  /courier/track/awb/{awb}      tracking
//
// UNCONFIRMED until live credentials are available: Shiprocket's public documentation site could not be read here, so
// the request bodies follow the helpsheet and well-known field names, and every parser below is deliberately tolerant
// (reads several plausible shapes, never throws on a missing optional field). Anything a real response contradicts is
// fixed in the parsers alone; nothing else in the CRM depends on Shiprocket's raw shapes.

export interface ShiprocketOrderItem {
  name: string;
  sku: string;
  units: number;
  selling_price: number;
  discount?: number;
  tax?: number;
  hsn?: string;
}

export interface CreateOrderRequest {
  order_id: string;
  order_date: string;
  pickup_location: string;
  billing_customer_name: string;
  billing_last_name: string;
  billing_address: string;
  billing_address_2?: string;
  billing_city: string;
  billing_pincode: string;
  billing_state: string;
  billing_country: string;
  billing_email: string;
  billing_phone: string;
  shipping_is_billing: true;
  order_items: ShiprocketOrderItem[];
  payment_method: "Prepaid" | "COD";
  shipping_charges: number;
  total_discount: number;
  /** Not calculated by Shiprocket: for a COD order this is the amount to collect. */
  sub_total: number;
  length: number;
  breadth: number;
  height: number;
  weight: number;
}

export interface CreatedOrder {
  orderId: string;
  shipmentId: string;
  awb: string | null;
  courierName: string | null;
  courierCompanyId: number | null;
}

export interface CourierOption {
  courierId: number;
  name: string;
  rate: number | null;
  etd: string | null;
  estimatedDays: string | null;
  cod: boolean | null;
  rating: number | null;
}

export interface AssignedAwb {
  awb: string;
  courierName: string | null;
  courierCompanyId: number | null;
}

export interface PickupResult {
  scheduledDate: string | null;
  tokenNumber: string | null;
}

export interface TrackingResult {
  awb: string;
  currentStatus: string | null;
  trackUrl: string | null;
  etd: string | null;
  courierName: string | null;
  activities: { date: string | null; status: string | null; location: string | null }[];
}

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseCreatedOrder(json: unknown): CreatedOrder | null {
  const body = asRecord(json);
  const shipmentId = asString(body.shipment_id);
  const orderId = asString(body.order_id);
  if (!shipmentId || !orderId) return null;
  return { orderId, shipmentId, awb: asString(body.awb_code), courierName: asString(body.courier_name), courierCompanyId: num(body.courier_company_id) };
}

export function parseCouriers(json: unknown): CourierOption[] {
  const list = asRecord(asRecord(json).data).available_courier_companies;
  if (!Array.isArray(list)) return [];
  const out: CourierOption[] = [];
  for (const item of list) {
    const c = asRecord(item);
    const courierId = num(c.courier_company_id);
    const name = asString(c.courier_name);
    if (courierId === null || !name) continue;
    out.push({
      courierId,
      name,
      rate: num(c.rate ?? c.freight_charge),
      etd: asString(c.etd),
      estimatedDays: asString(c.estimated_delivery_days),
      cod: c.cod === undefined ? null : c.cod === 1 || c.cod === true,
      rating: num(c.rating),
    });
  }
  return out;
}

export function parseAssignedAwb(json: unknown): AssignedAwb | null {
  const body = asRecord(json);
  const response = asRecord(body.response);
  const data = asRecord(response.data ?? body.data);
  const awb = asString(data.awb_code ?? body.awb_code);
  if (!awb) return null;
  return { awb, courierName: asString(data.courier_name ?? body.courier_name), courierCompanyId: num(data.courier_company_id ?? body.courier_company_id) };
}

export function parsePickup(json: unknown): PickupResult {
  const body = asRecord(json);
  const response = asRecord(body.response);
  return { scheduledDate: asString(response.pickup_scheduled_date ?? body.pickup_scheduled_date), tokenNumber: asString(response.pickup_token_number ?? body.pickup_token_number) };
}

export function parseLabelUrl(json: unknown): string | null {
  const body = asRecord(json);
  return asString(body.label_url ?? asRecord(body.response).label_url);
}

export function parseTracking(json: unknown, awb: string): TrackingResult | null {
  const data = asRecord(asRecord(json).tracking_data);
  if (Object.keys(data).length === 0 || asString(data.error)) return null;
  const track = Array.isArray(data.shipment_track) ? asRecord(data.shipment_track[0]) : {};
  const activities = Array.isArray(data.shipment_track_activities) ? data.shipment_track_activities : [];
  return {
    awb,
    currentStatus: asString(track.current_status) ?? asString(data.shipment_status_text),
    trackUrl: asString(data.track_url),
    etd: asString(data.etd),
    courierName: asString(track.courier_name),
    activities: activities.slice(0, 50).map((a) => {
      const row = asRecord(a);
      return { date: asString(row.date), status: asString(row["sr-status-label"] ?? row.activity), location: asString(row.location) };
    }),
  };
}

export class ShiprocketClient {
  private readonly tokens: ShiprocketTokenProvider;

  constructor(
    private readonly config: ShiprocketConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    tokens?: ShiprocketTokenProvider,
  ) {
    // Tests inject their own fetch (and so their own provider); real use shares one token per credential set.
    this.tokens = tokens ?? (fetchImpl === fetch ? sharedTokenProvider(config) : new ShiprocketTokenProvider(config, fetchImpl));
  }

  /** An authenticated call. A 401 means the token expired or was replaced: log in once more and retry the call once. */
  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.tokens.getToken();
      try {
        const { json } = await requestJson({ provider: "SHIPROCKET", fetchImpl: this.fetchImpl, url: `${this.config.baseUrl}${path}`, method, headers: { Authorization: `Bearer ${token}` }, body });
        return json;
      } catch (error) {
        if (error instanceof ProviderHttpError && error.status === 401 && attempt === 0) {
          this.tokens.invalidate(token);
          continue;
        }
        throw error;
      }
    }
  }

  async createOrder(request: CreateOrderRequest): Promise<CreatedOrder> {
    const created = parseCreatedOrder(await this.call("POST", "/orders/create/adhoc", request));
    if (!created) throw new ProviderHttpError("SHIPROCKET", null, "Shiprocket did not confirm the order", false);
    return created;
  }

  /** Couriers that can carry an existing Shiprocket order. */
  async getCouriers(shiprocketOrderId: string): Promise<CourierOption[]> {
    return parseCouriers(await this.call("GET", `/courier/serviceability/?order_id=${encodeURIComponent(shiprocketOrderId)}`));
  }

  async assignAwb(shipmentId: string, courierId: number): Promise<AssignedAwb> {
    const assigned = parseAssignedAwb(await this.call("POST", "/courier/assign/awb", { shipment_id: shipmentId, courier_id: courierId }));
    if (!assigned) throw new ProviderHttpError("SHIPROCKET", null, "Shiprocket did not assign an AWB for this courier", false);
    return assigned;
  }

  async generatePickup(shipmentId: string): Promise<PickupResult> {
    return parsePickup(await this.call("POST", "/courier/generate/pickup", { shipment_id: [shipmentId] }));
  }

  async generateLabel(shipmentId: string): Promise<string> {
    const url = parseLabelUrl(await this.call("POST", "/courier/generate/label", { shipment_id: [shipmentId] }));
    if (!url) throw new ProviderHttpError("SHIPROCKET", null, "Shiprocket did not return a label", false);
    return url;
  }

  async track(awb: string): Promise<TrackingResult | null> {
    return parseTracking(await this.call("GET", `/courier/track/awb/${encodeURIComponent(awb)}`), awb);
  }
}
