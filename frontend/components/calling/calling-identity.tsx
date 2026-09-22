import type { CallingIdentity as CallingIdentityData } from "@/lib/api-client/types/calls.types";

/**
 * Always driven by the backend's response — never a hardcoded number. `POST /api/calls` only
 * returns the calling identity in its *success* response, so before a call is actually started
 * there is nothing real to show yet; pass `identity={null}` with a `pendingMessage` for that case.
 */
export function CallingIdentity({
  identity,
  pendingMessage = "Calling number unavailable",
}: {
  identity?: CallingIdentityData | null;
  pendingMessage?: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">Calling from</p>
      {identity?.number ? (
        <p className="text-sm font-medium tabular-nums">
          {identity.displayName ? `${identity.displayName} · ${identity.number}` : identity.number}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground italic">{pendingMessage}</p>
      )}
    </div>
  );
}
