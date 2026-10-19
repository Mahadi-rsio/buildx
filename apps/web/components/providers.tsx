"use client";

import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "@/components/query-provider";
import { useConversationSync } from "@/hooks/use-conversation-sync";

function ConversationSyncLoop(): null {
  useConversationSync();
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryProvider>
        <TooltipProvider delay={200}>{children}</TooltipProvider>
        <ConversationSyncLoop />
      </QueryProvider>
    </ThemeProvider>
  );
}
