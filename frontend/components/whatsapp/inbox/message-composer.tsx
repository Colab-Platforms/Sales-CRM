"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { FileText, Film, Music, Paperclip, Send, Smile, Image as ImageIcon, MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { getErrorMessage } from "@/lib/api-client/client";
import { useSendConversationTextMutation } from "@/lib/api-client/mutations/whatsapp-conversation.mutations";

// Traced against the actual provider before writing any of this UI: AiSensy's Campaign API
// (backend/src/modules/whatsapp/whatsapp.aisensy.provider.ts) and Gupshup's template endpoint both
// expose only sendTemplateMessage() - no free-text send. The Meta Cloud API provider (added
// separately) DOES support free text (POST /whatsapp/conversations/:leadId/messages, gated server-
// side to Meta-only AND to Meta's 24-hour service window) - so free text is enabled here only when the backend's
// capability check (`canSendFreeText`) allows it; otherwise it stays honestly blocked with the backend's reason.
const FREE_TEXT_BLOCKED_FALLBACK = "Free-text messages are not available for this conversation right now. Send an approved template instead.";
const UNCONFIRMED_MEDIA_REASON = "Not confirmed supported by AiSensy's Campaign API - only image/document media is documented.";

const EMOJI = ["😀", "😂", "😊", "😍", "🙏", "👍", "👋", "🎉", "❤️", "🔥", "✅", "❌", "📦", "🚚", "💰", "📅", "⏰", "😢", "😮", "🤔"];

// Opens the same existing SendWhatsAppDialog, where the "Attach media (optional)" field actually
// sends this through the real, confirmed AiSensy payload - never a second/fake send path.
const SUPPORTED_ATTACHMENTS: { label: string; icon: typeof ImageIcon }[] = [
  { label: "Image", icon: ImageIcon },
  { label: "Document/PDF", icon: FileText },
];
const UNSUPPORTED_ATTACHMENTS: { label: string; icon: typeof ImageIcon }[] = [
  { label: "Video", icon: Film },
  { label: "Audio", icon: Music },
  { label: "File", icon: Paperclip },
];

export function MessageComposer({
  leadId,
  canSendFreeText,
  blockedMessage,
  onOpenTemplateSend,
  disabled,
}: {
  leadId: string;
  canSendFreeText: boolean;
  /** The backend's explanation of why free text is unavailable (wrong provider / closed 24-hour window / Meta not configured). */
  blockedMessage?: string | null;
  onOpenTemplateSend: () => void;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [blocked, setBlocked] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendText = useSendConversationTextMutation();

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  function handleAttemptSend() {
    if (!text.trim()) return;
    if (!canSendFreeText) {
      // Never a fake send: no API call happens here, only an honest explanation of the real limitation.
      setBlocked(true);
      return;
    }
    const body = text;
    setText("");
    sendText.mutate(
      { leadId, variables: { text: body } },
      { onError: (err) => { toast.error(getErrorMessage(err, "Could not send message.")); setText(body); } },
    );
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleAttemptSend();
    }
  }

  function insertEmoji(emoji: string) {
    setText((t) => t + emoji);
    setBlocked(false);
    textareaRef.current?.focus();
  }

  return (
    <div className="flex flex-col gap-1.5">
      {blocked ? (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <span>{blockedMessage ?? FREE_TEXT_BLOCKED_FALLBACK}</span>
          <button type="button" onClick={onOpenTemplateSend} className="shrink-0 font-medium underline underline-offset-2">
            Use a template instead
          </button>
        </div>
      ) : null}

      <div className="flex items-end gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Attach" />}>
            <Paperclip />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SUPPORTED_ATTACHMENTS.map(({ label, icon: Icon }) => (
              <DropdownMenuItem key={label} onClick={onOpenTemplateSend} disabled={disabled} className="gap-2">
                <Icon className="size-4" />
                <span className="flex-1">{label}</span>
                <span className="text-[0.65rem] text-muted-foreground">via template</span>
              </DropdownMenuItem>
            ))}
            {UNSUPPORTED_ATTACHMENTS.map(({ label, icon: Icon }) => (
              <DropdownMenuItem key={label} disabled title={UNCONFIRMED_MEDIA_REASON} className="gap-2">
                <Icon className="size-4" />
                <span className="flex-1">{label}</span>
                <span className="text-[0.65rem] text-muted-foreground">Unsupported</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Emoji" />}>
            <Smile />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <div className="grid grid-cols-8 gap-0.5 p-1">
              {EMOJI.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => insertEmoji(emoji)}
                  className="rounded-md p-1.5 text-lg hover:bg-muted"
                  aria-label={`Insert ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="icon-sm" onClick={onOpenTemplateSend} disabled={disabled} aria-label="Send an approved template" title="Send an approved template">
          <MessageSquareText />
        </Button>

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setBlocked(false);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          placeholder={disabled ? "This customer has no phone number on file" : "Type a message…"}
          className={cn(
            "max-h-[120px] min-h-9 flex-1 resize-none rounded-2xl border-[1.5px] border-input bg-card px-3 py-2 text-sm outline-none transition-colors",
            "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
            "disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 dark:bg-input/30",
          )}
        />

        <Button size="icon" onClick={handleAttemptSend} disabled={disabled || !text.trim() || sendText.isPending} aria-label="Send">
          <Send />
        </Button>
      </div>
    </div>
  );
}
