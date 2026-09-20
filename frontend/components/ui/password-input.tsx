"use client"

import * as React from "react"
import { Eye, EyeOff } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { cn } from "cn"

function PasswordInput({
  className,
  wrapperClassName,
  disabled,
  ...props
}: React.ComponentProps<typeof Input> & {
  wrapperClassName?: string
}) {
  const [showPassword, setShowPassword] = React.useState(false)

  return (
    <div className={cn("relative flex items-center w-full", wrapperClassName)}>
      <Input
        type={showPassword ? "text" : "password"}
        className={cn(
          "pr-9 [&::-ms-reveal]:hidden [&::-ms-clear]:hidden",
          className
        )}
        disabled={disabled}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-1.5 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:bg-transparent hover:text-foreground"
        onClick={() => setShowPassword((prev) => !prev)}
        disabled={disabled}
        tabIndex={-1}
        aria-label={showPassword ? "Hide password" : "Show password"}
      >
        {showPassword ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
        <span className="sr-only">
          {showPassword ? "Hide password" : "Show password"}
        </span>
      </Button>
    </div>
  )
}

export { PasswordInput }
