import { cn } from "@/lib/utils";

/**
 * Hand-drawn wordmark badge: an uneven inked frame around a rising pipeline
 * line. Drawn rather than imported so the stroke matches the sketch borders
 * used by cards and buttons.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      role="img"
      aria-label="AVATAR CRM"
      className={cn("text-primary", className)}
    >
      <path
        d="M7.4 4.9c8.2-1 17.1-1.3 25.4-.4 1.7.2 2.7 1.2 2.8 2.9.8 8.3.7 16.6-.1 24.9-.2 1.6-1.2 2.6-2.8 2.8-8.4.9-16.8.9-25.2 0-1.7-.2-2.6-1.1-2.8-2.8-.9-8.3-.9-16.6 0-24.9.2-1.6 1-2.4 2.7-2.5z"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M10.8 26.8c2.7-.4 4.5-3.3 6.4-5.5 1.4-1.6 2.7-1.5 4 .1 1.1 1.3 2 1.4 3-.1 1.7-2.5 3.4-5 5.4-7.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M26.2 13.6l3.5.3.2 3.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
