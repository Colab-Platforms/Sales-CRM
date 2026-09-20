// Kept in sync with backend/src/modules/whatsapp/whatsapp.types.ts (E7.1 foundation).

export interface WhatsAppStatus {
  configured: boolean;
  provider: string | null;
  /** Only present when configured is false - variable names only, never secret values. */
  problems?: string[];
}
