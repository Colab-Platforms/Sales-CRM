// What the Customer 360 page offers. A READ-ONLY view (the server sets readOnly: the customer was reached from a visible order but is not the viewer's own) shows the profile and the orders only:
// every action and every section that is served by a strictly-scoped endpoint (edit, delete, send, conversation, timeline, assignment history, audit) is left out instead of failing with "Customer not found".
export interface Customer360Sections {
  edit: boolean;
  delete: boolean;
  sendWhatsApp: boolean;
  conversation: boolean;
  timeline: boolean;
  history: boolean;
}

export function customer360Sections(opts: { readOnly: boolean; role: string | undefined }): Customer360Sections {
  if (opts.readOnly) return { edit: false, delete: false, sendWhatsApp: false, conversation: false, timeline: false, history: false };
  return { edit: true, delete: opts.role === "ADMIN", sendWhatsApp: true, conversation: true, timeline: true, history: true };
}

export const READ_ONLY_NOTICE = "Read-only view: this customer is not assigned to you, so only the profile and orders are shown.";
