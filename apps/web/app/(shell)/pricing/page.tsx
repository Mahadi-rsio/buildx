"use client";

import Link from "next/link";
import { ArrowLeft, Check, Sparkles, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useShell, useShellMeta } from "@/components/shell/shell-context";
import { formatTaka, MIN_TOP_UP_BDT, REQUESTS_PER_TAKA } from "@/lib/credits";

const PLANS = [
  {
    name: "Pro",
    price: "৳1,000",
    cadence: "/month",
    description: "For steady daily building with a predictable request budget.",
    features: [
      "2,000 AI requests per month",
      "Priority workspace starts",
      "Long-running terminal sessions",
      "Shared history across devices",
    ],
    cta: "Get Pro",
    highlight: true,
  },
  {
    name: "Pay as you go",
    price: `From ${formatTaka(MIN_TOP_UP_BDT)}`,
    cadence: "top-up",
    description: "Add credit only when you need it. Nothing renews automatically.",
    features: [
      `৳1 = ${REQUESTS_PER_TAKA} AI requests`,
      "Credits stay in this browser (demo)",
      "No subscription or auto-renewal",
      "Same sandbox, models, and tools",
    ],
    cta: "Add credit",
    highlight: false,
  },
];

export default function PricingPage() {
  useShellMeta({ status: "idle" });
  const { setUpgradeOpen } = useShell();

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto w-full max-w-3xl px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-5 sm:px-6 sm:pt-10">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to chat
        </Link>

        <header className="mt-5">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3" />
            Plans &amp; credits
          </div>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Keep the agent running
          </h1>
          <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
            Daily limits keep shared demo usage predictable. Add credits for
            extra requests, or browse the Pro plan. No real charges are made in
            this demo.
          </p>
        </header>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {PLANS.map((plan) => (
            <section
              key={plan.name}
              className={
                plan.highlight
                  ? "relative overflow-hidden rounded-2xl border border-foreground/20 bg-surface p-5 shadow-sm"
                  : "relative overflow-hidden rounded-2xl border border-border bg-surface/50 p-5"
              }
            >
              {plan.highlight ? (
                <span className="absolute right-4 top-4 rounded-full bg-foreground px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-background">
                  Popular
                </span>
              ) : null}
              <h2 className="text-sm font-medium text-foreground">{plan.name}</h2>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="text-2xl font-semibold tracking-tight text-foreground">
                  {plan.price}
                </span>
                <span className="text-xs text-muted-foreground">
                  {plan.cadence}
                </span>
              </p>
              <p className="mt-2 min-h-10 text-xs leading-relaxed text-muted-foreground">
                {plan.description}
              </p>
              <ul className="mt-4 space-y-2">
                {plan.features.map((feature) => (
                  <li
                    key={feature}
                    className="flex items-start gap-2 text-xs text-foreground/80"
                  >
                    <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant={plan.highlight ? "default" : "outline"}
                className="mt-5 h-9 w-full"
                onClick={() => setUpgradeOpen(true)}
              >
                {plan.highlight ? (
                  <Sparkles className="size-3.5" />
                ) : (
                  <Wallet className="size-3.5" />
                )}
                {plan.cta}
              </Button>
            </section>
          ))}
        </div>

        <p className="mt-5 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          Demo only, no real charges. Top-ups and plan actions do not contact a
          payment provider and are stored in this browser.
        </p>
      </div>
    </div>
  );
}
