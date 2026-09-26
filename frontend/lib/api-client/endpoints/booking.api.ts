import { apiClient } from "../client";
import type { ApiEnvelope } from "../types/common.types";
import type {
  BookingLookupResult,
  BookingProduct,
  BookingQuote,
  BookingQuoteRequest,
  CreateBookingRequest,
  CreateBookingResponse,
  ServiceabilityResult,
} from "../types/booking.types";

export const bookingApi = {
  async lookup(mobile: string): Promise<BookingLookupResult> {
    const res = await apiClient.get<ApiEnvelope<BookingLookupResult>>("/orders/booking/leads", { params: { mobile } });
    return res.data.data;
  },

  async catalog(search?: string): Promise<BookingProduct[]> {
    const res = await apiClient.get<ApiEnvelope<BookingProduct[]>>("/orders/booking/catalog", { params: { search } });
    return res.data.data;
  },

  async serviceability(pincode: string, cod: boolean): Promise<ServiceabilityResult> {
    const res = await apiClient.get<ApiEnvelope<ServiceabilityResult>>("/orders/booking/serviceability", {
      params: { pincode, cod: String(cod) },
    });
    return res.data.data;
  },

  async quote(body: BookingQuoteRequest): Promise<BookingQuote> {
    const res = await apiClient.post<ApiEnvelope<BookingQuote>>("/orders/booking/quote", body);
    return res.data.data;
  },

  async createOrder(body: CreateBookingRequest): Promise<CreateBookingResponse> {
    const res = await apiClient.post<ApiEnvelope<CreateBookingResponse>>("/orders/booking/orders", body);
    return res.data.data;
  },
};