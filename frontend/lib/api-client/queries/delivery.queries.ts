import { queryOptions } from "@tanstack/react-query";
import { deliveryApi } from "../endpoints/delivery.api";

export const deliveryKeys = {
  all: ["delivery"] as const,
  pincode: (pincode: string) => [...deliveryKeys.all, "pincode", pincode] as const,
  serviceability: (pincode: string, cod: boolean, weight: number) => [...deliveryKeys.all, "serviceability", pincode, cod, weight] as const,
  lastAddress: (leadId: string) => [...deliveryKeys.all, "last-address", leadId] as const,
};

// A pincode's existence rarely changes (the backend caches it for a day too), so it is not refetched while a form is open.
export const pincodeQueryOptions = (pincode: string) =>
  queryOptions({ queryKey: deliveryKeys.pincode(pincode), queryFn: () => deliveryApi.pincode(pincode), staleTime: 24 * 60 * 60 * 1000, retry: false });

// Serviceability depends on the payment type (COD vs prepaid) and the weight, so both are part of the key.
export const serviceabilityQueryOptions = (pincode: string, cod: boolean, weight: number) =>
  queryOptions({ queryKey: deliveryKeys.serviceability(pincode, cod, weight), queryFn: () => deliveryApi.serviceability({ pincode, cod, weight }), staleTime: 5 * 60 * 1000, retry: false });

export const lastAddressQueryOptions = (leadId: string) =>
  queryOptions({ queryKey: deliveryKeys.lastAddress(leadId), queryFn: () => deliveryApi.lastAddress(leadId), staleTime: 60 * 1000, retry: false });
