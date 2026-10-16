import { cn } from "@/lib/utils";

/**
 * Wordmark badge: a rising pipeline line in the lime highlight on a solid
 * ink disc, matching the black-and-lime accents used across the UI.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      role="img"
      aria-label="Avance Sales CRM"
      className={cn("text-highlight", className)}
    >
      <circle cx="20" cy="20" r="20" className="fill-primary" />
      <path
        d="M11 26l6-6.5 4 3.5 8-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M24 14h5v5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
