"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { ordersApi } from "@/lib/api-client/endpoints/orders.api";
import type { PlaceAddress } from "@/lib/api-client/types/orders.types";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

/** Google Places typeahead. Picking a suggestion fills the address fields below it (all stay editable); typing the address by hand always still works. */
export function AddressSearch({ onPick, pincode }: { onPick: (place: PlaceAddress) => void; /** A complete 6-digit pincode already entered: suggestions are limited to its area. Empty = all of India. */ pincode?: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One session token per search -> pick (Google bills the whole typing session once). Renewed after every pick.
  const session = useRef(crypto.randomUUID());
  const debounced = useDebouncedValue(text.trim(), 350);
  const enabled = open && debounced.length >= 3 && debounced === text.trim();

  const suggestions = useQuery({
    queryKey: ["orders", "address-suggest", debounced, pincode ?? ""],
    queryFn: () => ordersApi.suggestAddress(debounced, session.current, pincode || undefined),
    enabled,
    staleTime: 60_000,
    retry: false,
  });

  async function pick(placeId: string, label: string) {
    setPicking(true);
    setError(null);
    try {
      onPick(await ordersApi.getAddressPlace(placeId, session.current));
      setText(label);
      setOpen(false);
      session.current = crypto.randomUUID();
    } catch {
      setError("Could not load that address. Enter it by hand below.");
    } finally {
      setPicking(false);
    }
  }

  const list = suggestions.data ?? [];
  return (
    <div className="relative grid gap-1 sm:col-span-2">
      <label htmlFor="ship-search" className="text-sm font-medium">
        Search address
      </label>
      <Input
        id="ship-search"
        autoComplete="off"
        placeholder="Start typing the building, street or area…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.preventDefault(); // Enter must never submit the order form
        }}
      />
      {open && enabled && list.length > 0 ? (
        <ul role="listbox" className="absolute top-full z-50 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover text-sm shadow-md">
          {list.map((s) => (
            <li key={s.placeId} role="option" aria-selected={false}>
              <button type="button" disabled={picking} onMouseDown={(e) => e.preventDefault()} onClick={() => void pick(s.placeId, s.text)} className="block w-full px-3 py-2 text-left hover:bg-muted disabled:opacity-60">
                <span className="font-medium">{s.mainText}</span> <span className="text-muted-foreground">{s.secondaryText}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{pincode ? `Searching within pincode ${pincode}. Clear the pincode to search all of India. ` : ""}Pick a suggestion to fill the fields below, then add the flat / house number. You can still type everything by hand.</p>
      )}
    </div>
  );
}
