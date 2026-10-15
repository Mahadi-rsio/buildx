import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "buildx — agent dashboard",
  description:
    "Run the buildx coding agent against a sandboxed workspace and watch every step live.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-6">
            <Link
              href="/"
              className="font-mono text-sm font-semibold tracking-tight text-neutral-100"
            >
              buildx<span className="text-neutral-500">/agent</span>
            </Link>
            <span className="font-mono text-[11px] text-neutral-500">
              sandboxed runs · append-only events
            </span>
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
