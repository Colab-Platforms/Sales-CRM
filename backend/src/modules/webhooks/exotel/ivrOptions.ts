/**
 * Application-level interpretation of our current IVR menu.
 * This is NOT stored as a database enum (schema has no IVR column yet) —
 * it only classifies digits already sitting in webhook_events.payload.
 */
export const IVR_OPTION_MAP: Record<string, string> = {
  "1": "PRODUCT_INFORMATION",
  "2": "ORDER_QUERY",
  "3": "CUSTOMER_SUPPORT",
  "4": "CALLBACK",
};

export const UNKNOWN_IVR_OPTION = "UNKNOWN_OPTION";

export function resolveIvrOption(digit: string): string {
  return IVR_OPTION_MAP[digit] ?? UNKNOWN_IVR_OPTION;
}

export function resolveIvrAction(ivrOption: string | null): string {
  if (ivrOption === null) return "NO_IVR_INPUT";
  if (ivrOption === "CALLBACK") return "CALLBACK_REQUESTED";
  return ivrOption;
}
