// Kept in sync with backend/src/modules/whatsapp/whatsapp.automation.types.ts.

export type WhatsAppAutomationType = "ORDER_CONFIRMED" | "ORDER_SHIPPED" | "ORDER_OUT_FOR_DELIVERY" | "ORDER_DELIVERED" | "PAYMENT_PENDING" | "FOLLOW_UP_DUE";

export interface AutomationConfig {
  automationType: WhatsAppAutomationType;
  enabled: boolean;
  template: { id: string; name: string; status: string } | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: string | null;
}

export interface UpdateAutomationConfigInput {
  enabled?: boolean;
  templateId?: string | null;
}
