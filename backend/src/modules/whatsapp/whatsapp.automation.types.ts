import type { WhatsAppAutomationRunStatus, WhatsAppAutomationType } from "../../../generated/prisma/enums.js";

// E7.6 Lifecycle Automation. One entry per required automation (see the E7.6 spec's six events).
export const AUTOMATION_TYPES: WhatsAppAutomationType[] = [
  "ORDER_CONFIRMED",
  "ORDER_SHIPPED",
  "ORDER_OUT_FOR_DELIVERY",
  "ORDER_DELIVERED",
  "PAYMENT_PENDING",
  "FOLLOW_UP_DUE",
];

export interface AutomationConfigView {
  automationType: WhatsAppAutomationType;
  enabled: boolean;
  template: { id: string; name: string; status: string } | null;
  updatedBy: { id: string; name: string } | null;
  updatedAt: string | null;
}

export interface UpdateAutomationConfigInput {
  enabled?: boolean;
  /** Pass null to clear the configured template; omit to leave it unchanged. */
  templateId?: string | null;
}

/** What actually happened for one dispatch() call - never thrown, always returned, so a caller
 *  (an order sync, a scheduler sweep) can never be broken by an automation outcome. */
export type AutomationOutcome =
  | { outcome: "sent"; runId: string; whatsAppMessageId: string }
  | { outcome: "duplicate" } // the eventKey was already claimed by an earlier run
  | { outcome: "skipped"; runId: string | null; reason: string }
  | { outcome: "failed"; runId: string | null; reason: string };

export interface DispatchInput {
  type: WhatsAppAutomationType;
  leadId: string;
  orderId?: string;
  /** Uniquely identifies the one real-world occurrence this call may fire for - see
   *  whatsapp.prisma's WhatsAppAutomationRun.eventKey doc comment for examples. */
  eventKey: string;
}

export interface AutomationRunSummary {
  id: string;
  automationType: WhatsAppAutomationType;
  status: WhatsAppAutomationRunStatus;
  reason: string | null;
  whatsAppMessageId: string | null;
  executedAt: string;
}
