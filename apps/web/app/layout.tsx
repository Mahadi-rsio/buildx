import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { Activity } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });
const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "buildx — agent dashboard",
  description:
    "Run the buildx coding agent against a sandboxed workspace and watch every step live.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={cn("dark font-sans", geist.variable, geistMono.variable)}
    >
      <body>
        <TooltipProvider>
          <div className="relative min-h-dvh">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
            >
              <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,oklch(0.28_0_0)_0%,transparent_55%)]" />
              <div className="absolute inset-0 bg-[linear-gradient(to_right,oklch(1_0_0_/0.03)_1px,transparent_1px),linear-gradient(to_bottom,oklch(1_0_0_/0.03)_1px,transparent_1px)] bg-size-[48px_48px] [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]" />
            </div>

            <header className="sticky top-0 z-40 border-b border-border/80 bg-background/80 backdrop-blur-md">
              <div className="mx-auto flex h-14 w-full max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6">
                <Link href="/" className="flex items-center gap-2.5">
                  <span className="flex size-7 items-center justify-center rounded-md bg-foreground text-background">
                    <Activity className="size-3.5" strokeWidth={2.5} />
                  </span>
                  <span className="font-mono text-sm font-semibold tracking-tight">
                    buildx
                    <span className="text-muted-foreground">/agent</span>
                  </span>
                </Link>
                <div className="flex items-center gap-3">
                  <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
                    sandboxed runs · live events
                  </span>
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    <span className="size-1.5 rounded-full bg-emerald-400" />
                    local
                  </span>
                </div>
              </div>
            </header>

            <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8">
              {children}
            </main>
          </div>
        </TooltipProvider>
      </body>
    </html>
  );
}
