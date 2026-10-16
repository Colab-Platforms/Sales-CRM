// Google Address Validation API (https://developers.google.com/maps/documentation/address-validation).
// Server-side only: the key never reaches the browser. Fail-open by design - no key, a timeout or a Google outage returns SKIPPED, never an exception,
// so order creation does not depend on Google being up.

export type AddressValidationStatus = "VERIFIED" | "UNCONFIRMED" | "INVALID" | "SKIPPED";

export interface AddressToValidate {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export interface AddressValidationResult {
  status: AddressValidationStatus;
  /** Why the status is not VERIFIED, in words a telecaller can act on. */
  reasons: string[];
  /** Google's corrected / standardised address, to offer as "Use this address?". */
  formattedAddress?: string;
  /** Pincode Google resolved, when it differs from what was typed. */
  suggestedPincode?: string;
  lat?: number;
  lng?: number;
  granularity?: string;
}

const ENDPOINT = "https://addressvalidation.googleapis.com/v1:validateAddress";
const TIMEOUT_MS = 4000;

const skipped = (reason: string): AddressValidationResult => ({ status: "SKIPPED", reasons: [reason] });

interface GoogleResponse {
  result?: {
    verdict?: { addressComplete?: boolean; hasUnconfirmedComponents?: boolean; hasInferredComponents?: boolean; validationGranularity?: string };
    address?: {
      formattedAddress?: string;
      postalAddress?: { postalCode?: string };
      missingComponentTypes?: string[];
      unconfirmedComponentTypes?: string[];
    };
    geocode?: { location?: { latitude?: number; longitude?: number } };
  };
}

/** Pure mapping of Google's verdict to our status (exported for tests). */
export function interpretVerdict(res: GoogleResponse, typedPincode?: string): AddressValidationResult {
  const verdict = res.result?.verdict;
  if (!verdict) return skipped("Address check returned no verdict");

  const address = res.result?.address;
  const granularity = verdict.validationGranularity;
  const reasons: string[] = [];

  const googlePincode = address?.postalAddress?.postalCode?.replace(/\s/g, "");
  const suggestedPincode = googlePincode && typedPincode && googlePincode !== typedPincode ? googlePincode : undefined;
  if (suggestedPincode) reasons.push(`Pincode looks wrong for this address (Google suggests ${suggestedPincode})`);
  if (address?.missingComponentTypes?.length) reasons.push(`Missing: ${address.missingComponentTypes.join(", ")}`);
  // Google sometimes lists postal_code as unconfirmed while its own corrected address carries the very pincode that was typed: that pincode is fine.
  const pincodeAgrees = !!typedPincode && !!address?.formattedAddress?.includes(typedPincode);
  const unconfirmed = (address?.unconfirmedComponentTypes ?? []).filter((t) => !(t === "postal_code" && pincodeAgrees));
  if (unconfirmed.length) reasons.push(`Could not confirm: ${unconfirmed.join(", ")}`);

  const loc = res.result?.geocode?.location;
  const base = {
    reasons,
    formattedAddress: address?.formattedAddress,
    suggestedPincode,
    lat: loc?.latitude,
    lng: loc?.longitude,
    granularity,
  };

  // OTHER = Google could not even place it on a street/route: not a real address.
  if (granularity === "OTHER" || !address?.formattedAddress) {
    return { ...base, status: "INVALID", reasons: reasons.length ? reasons : ["Address could not be found"] };
  }
  const precise = granularity === "PREMISE" || granularity === "SUB_PREMISE";
  const onlyPincodeDoubt = !unconfirmed.length && !!address?.unconfirmedComponentTypes?.length;
  if (verdict.addressComplete && precise && (!verdict.hasUnconfirmedComponents || onlyPincodeDoubt) && !suggestedPincode) {
    return { ...base, status: "VERIFIED" };
  }
  if (!reasons.length) {
    reasons.push(
      verdict.addressComplete && granularity === "ROUTE"
        ? "Street and area are confirmed; the house / flat number could not be checked (Google has no building-level data here)"
        : "Address is only partly confirmed",
    );
  }
  return { ...base, status: "UNCONFIRMED", reasons };
}

export async function validateAddress(addr: AddressToValidate, fetchImpl: typeof fetch = fetch): Promise<AddressValidationResult> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return skipped("Address validation is not configured");

  const addressLines = [addr.line1, addr.line2].filter((l): l is string => !!l && l.trim().length > 0);
  const body = {
    address: {
      regionCode: "IN",
      addressLines,
      locality: addr.city,
      administrativeArea: addr.state,
      postalCode: addr.pincode,
    },
  };

  try {
    const response = await fetchImpl(`${ENDPOINT}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return skipped(`Address check unavailable (${response.status})`);
    return interpretVerdict((await response.json()) as GoogleResponse, addr.pincode);
  } catch {
    return skipped("Address check unavailable");
  }
}
