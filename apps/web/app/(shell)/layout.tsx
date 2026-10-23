import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { requirePageUser } from "@/lib/auth/server";

// Session checks read cookies/headers — this layout must render per request.
export const dynamic = "force-dynamic";

export default async function ShellLayout({ children }: { children: ReactNode }) {
  // Real enforcement (the proxy only does an optimistic cookie check).
  await requirePageUser();
  return <AppShell>{children}</AppShell>;
}
