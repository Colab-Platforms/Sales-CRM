// Google Places API (New): address typeahead + place details, proxied through the backend so the API key never reaches the browser.
// Enable "Places API (New)" in Google Cloud and allow it on the key (alongside Address Validation API).

export interface PlaceSuggestion {
  placeId: string;
  /** Full text, e.g. "Bangalore Palace, Palace Road, Vasanth Nagar, Bengaluru, Karnataka, India". */
  text: string;
  mainText: string;
  secondaryText: string;
}

/** A picked place, split into the Create Order form's own fields. */
export interface PlaceAddress {
  houseNumber: string;
  building: string;
  street: string;
  area: string;
  city: string;
  state: string;
  pincode: string;
  formattedAddress: string;
}

const TIMEOUT_MS = 4000;
const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";

export class PlacesUnavailableError extends Error {}

interface Component {
  longText?: string;
  types?: string[];
}

/** Pure mapping of Place Details components to form fields (exported for tests). */
export function mapPlace(place: { addressComponents?: Component[]; displayName?: { text?: string }; types?: string[]; formattedAddress?: string }): PlaceAddress {
  const comps = place.addressComponents ?? [];
  const get = (...types: string[]) => comps.find((c) => types.some((t) => c.types?.includes(t)))?.longText ?? "";
  const getAll = (...types: string[]) => comps.filter((c) => types.some((t) => c.types?.includes(t))).map((c) => c.longText ?? "").filter(Boolean);

  const isEstablishment = !!place.types?.some((t) => t === "establishment" || t === "point_of_interest");
  const premise = get("premise");
  return {
    houseNumber: [get("subpremise"), get("street_number")].filter(Boolean).join(", "),
    building: premise || (isEstablishment ? (place.displayName?.text ?? "") : ""),
    street: get("route"),
    area: [...new Set([...getAll("sublocality_level_2"), ...getAll("sublocality_level_1", "sublocality", "neighborhood")])].join(", "),
    city: get("locality") || get("administrative_area_level_3") || get("administrative_area_level_2"),
    state: get("administrative_area_level_1"),
    pincode: get("postal_code").replace(/\s/g, ""),
    formattedAddress: place.formattedAddress ?? "",
  };
}

function key(): string {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new PlacesUnavailableError("Address search is not configured");
  return k;
}

interface Rect {
  low: { latitude: number; longitude: number };
  high: { latitude: number; longitude: number };
}
const pincodeAreas = new Map<string, Rect | null>(); // pincode -> map area; a pincode's area never changes, so this lives for the process

/** The map area (viewport) of an Indian pincode, via Places Text Search. null = Google does not know it (then the search is not restricted). */
export async function pincodeArea(pincode: string, fetchImpl: typeof fetch = fetch): Promise<Rect | null> {
  if (pincodeAreas.has(pincode)) return pincodeAreas.get(pincode)!;
  const apiKey = key();
  try {
    const res = await fetchImpl("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.viewport" },
      body: JSON.stringify({ textQuery: `${pincode}, India`, regionCode: "IN", maxResultCount: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null; // not cached: a failed lookup may work next time
    const vp = ((await res.json()) as { places?: { viewport?: Rect }[] }).places?.[0]?.viewport;
    const area = vp?.low && vp?.high ? vp : null;
    pincodeAreas.set(pincode, area);
    return area;
  } catch {
    return null;
  }
}

export async function suggestPlaces(input: string, sessionToken: string | undefined, pincode?: string, fetchImpl: typeof fetch = fetch): Promise<PlaceSuggestion[]> {
  const apiKey = key();
  const area = pincode ? await pincodeArea(pincode, fetchImpl) : null;
  try {
    const res = await fetchImpl(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey },
      body: JSON.stringify({ input, includedRegionCodes: ["in"], languageCode: "en", ...(area ? { locationRestriction: { rectangle: area } } : {}), ...(sessionToken ? { sessionToken } : {}) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new PlacesUnavailableError(`Address search unavailable (${res.status})`);
    const json = (await res.json()) as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }[] };
    return (json.suggestions ?? []).flatMap((s) => {
      const p = s.placePrediction;
      if (!p?.placeId) return [];
      return [{ placeId: p.placeId, text: p.text?.text ?? "", mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "", secondaryText: p.structuredFormat?.secondaryText?.text ?? "" }];
    });
  } catch (e) {
    throw e instanceof PlacesUnavailableError ? e : new PlacesUnavailableError("Address search unavailable");
  }
}

export async function getPlaceAddress(placeId: string, sessionToken: string | undefined, fetchImpl: typeof fetch = fetch): Promise<PlaceAddress> {
  const apiKey = key();
  try {
    const url = `${DETAILS_URL}/${encodeURIComponent(placeId)}${sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : ""}`;
    const res = await fetchImpl(url, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "addressComponents,displayName,types,formattedAddress" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new PlacesUnavailableError(`Address search unavailable (${res.status})`);
    return mapPlace((await res.json()) as Parameters<typeof mapPlace>[0]);
  } catch (e) {
    throw e instanceof PlacesUnavailableError ? e : new PlacesUnavailableError("Address search unavailable");
  }
}
