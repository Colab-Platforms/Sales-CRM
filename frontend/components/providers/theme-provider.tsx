"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * The one place the theme is managed. It puts the `dark` class on <html> (the class every dark token and `dark:` variant keys off), remembers the choice in localStorage across sessions,
 * and - because next-themes writes a tiny inline script into the page head - applies it BEFORE the first paint, so a dark-mode user never sees a flash of the light theme.
 * Light stays the default (nobody's screen changes until they choose); "System" follows the device setting and tracks it live.
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="light" enableSystem storageKey="avance-crm-theme" disableTransitionOnChange {...props}>
      {children}
    </NextThemesProvider>
  );
}
