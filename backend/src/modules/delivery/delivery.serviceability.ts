// Delivery serviceability for the Create Order form, through the EXISTING Shiprocket integration (same credentials,
// same configured pickup location, same token handling as shipment creation). Valid pincode and serviceable pincode are
// different questions: this answers only the second one.
//
//   GET /courier/serviceability/?pickup_postcode=&delivery_postcode=&cod=&weight=
//
// The pickup postcode is not configured anywhere - the CRM only knows the pickup location's NAME - so it is read from
// Shiprocket's own pickup-location list (GET /settings/company/pickup) and cached briefly.
import { ProviderHttpError } from "../integrations/integrations.common.js";
import { ShiprocketClient } from "../shiprocket/shiprocket.client.js";
import { loadShiprocketConfig, ShiprocketConfigError, type ShiprocketConfig } from "../shiprocket/shiprocket.config.js";
import { PINCODE_PATTERN } from "./delivery.pincode.js";

export type ServiceabilityStatus = "serviceable" | "not_serviceable" | "unavailable";

export interface ServiceabilityResult {
  status: ServiceabilityStatus;
  couriers: number;
  /** Lowest freight rate among the available couriers (INR), when Shiprocket returned one. */
  cheapestRate: number | null;
  /** Fastest / slowest estimated delivery in days, when Shiprocket returned them. */
  minDays: number | null;
  maxDays: number | null;
  /** true only when the destination is NOT serviceable AND the deployment says such orders must be blocked. */
  blocksOrder: boolean;
  message: string | null;
}

export interface ServiceabilityDeps {
  client?: () => Pick<ShiprocketClient, "getPickupPostcode" | "checkServiceability">;
  config?: () => ShiprocketConfig;
  env?: Record<string, string | undefined>;
}

// ORDER_BLOCK_UNSERVICEABLE=false lets a salesperson create an order for a destination Shiprocket cannot serve (the CRM
// creates orders before any shipment exists). Default: blocked.
const blocks = (env: Record<string, string | undefined>) => (env.ORDER_BLOCK_UNSERVICEABLE ?? "true").trim().toLowerCase() !== "false";

// The pickup location's postcode rarely changes; ask Shiprocket at most once every 10 minutes per location name.
const PICKUP_TTL_MS = 10 * 60_000;
const pickupCache = new Map<string, { at: number; postcode: string }>();
export const clearPickupCache = () => pickupCache.clear();

const unavailable = (message: string): ServiceabilityResult => ({ status: "unavailable", couriers: 0, cheapestRate: null, minDays: null, maxDays: null, blocksOrder: false, message });

export async function checkServiceability(input: { pincode: string; cod: boolean; weightKg: number }, deps: ServiceabilityDeps = {}): Promise<ServiceabilityResult> {
  if (!PINCODE_PATTERN.test(input.pincode)) return unavailable("Enter a valid 6-digit pincode first.");
  if (!(input.weightKg > 0)) return unavailable("Courier serviceability requires shipment weight.");
  const env = deps.env ?? process.env;

  let client: Pick<ShiprocketClient, "getPickupPostcode" | "checkServiceability">;
  let pickupName: string;
  try {
    const config = (deps.config ?? loadShiprocketConfig)();
    pickupName = config.pickupLocation;
    client = deps.client ? deps.client() : new ShiprocketClient(config);
  } catch (error) {
    if (error instanceof ShiprocketConfigError) return unavailable("Delivery serviceability is not available: Shiprocket is not set up.");
    throw error;
  }

  try {
    const cached = pickupCache.get(pickupName);
    let pickupPostcode: string | null = cached && Date.now() - cached.at < PICKUP_TTL_MS ? cached.postcode : null;
    if (!pickupPostcode) {
      pickupPostcode = await client.getPickupPostcode(pickupName);
      if (pickupPostcode) pickupCache.set(pickupName, { at: Date.now(), postcode: pickupPostcode });
    }
    if (!pickupPostcode) return unavailable("Delivery serviceability is not available: the pickup location has no postcode in Shiprocket.");
    const result = await client.checkServiceability({ pickupPostcode, deliveryPostcode: input.pincode, cod: input.cod, weightKg: input.weightKg });
    if (result.couriers.length === 0) {
      return { status: "not_serviceable", couriers: 0, cheapestRate: null, minDays: null, maxDays: null, blocksOrder: blocks(env), message: "This pincode is currently not serviceable for delivery." };
    }
    const rates = result.couriers.map((c) => c.rate).filter((n): n is number => n !== null);
    const days = result.couriers.map((c) => c.days).filter((n): n is number => n !== null);
    return {
      status: "serviceable",
      couriers: result.couriers.length,
      cheapestRate: rates.length ? Math.min(...rates) : null,
      minDays: days.length ? Math.min(...days) : null,
      maxDays: days.length ? Math.max(...days) : null,
      blocksOrder: false,
      message: null,
    };
  } catch (error) {
    // A 404 from the serviceability endpoint is Shiprocket's way of saying "no courier serves this lane".
    if (error instanceof ProviderHttpError && error.status === 404 && /serviceab|courier/i.test(error.message)) {
      return { status: "not_serviceable", couriers: 0, cheapestRate: null, minDays: null, maxDays: null, blocksOrder: blocks(env), message: "This pincode is currently not serviceable for delivery." };
    }
    return unavailable("Could not check delivery right now. Try again in a moment.");
  }
}
