"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "cn"

/**
 * Styled wrapper around a plain `<select>`.
 *
 * The app uses native selects in several places (lead filters, inline status
 * editing, assignment dialogs) because they need no popup logic. Left bare they
 * pick up OS chrome and drift out of alignment with Input/Button, so this
 * matches their height, radius and padding and draws its own chevron.
 */
function NativeSelect({
  className,
  wrapperClassName,
  size = "default",
  children,
  ...props
}: Omit<React.ComponentProps<"select">, "size"> & {
  wrapperClassName?: string
  size?: "default" | "sm"
}) {
  return (
    <div className={cn("relative inline-flex w-full items-center", wrapperClassName)}>
      <select
        data-slot="native-select"
        data-size={size}
        className={cn(
          "w-full appearance-none rounded-[11px_9px_12px_9px] border-[1.5px] border-input bg-card pl-3 text-sm transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-muted/60 disabled:opacity-60 dark:bg-input/30",
          size === "sm" ? "h-8 pr-8" : "h-9 pr-9",
          className
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute text-muted-foreground",
          size === "sm" ? "right-2.5 size-3.5" : "right-3 size-4"
        )}
      />
    </div>
  )
}

export { NativeSelect }
