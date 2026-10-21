"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Check, Loader2, Sparkles, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useShell } from "@/components/shell/shell-context";
import {
  MIN_TOP_UP_BDT,
  createTopUp,
  formatTaka,
  normalizeTopUp,
  readCreditBalance,
  requestsForAmount,
} from "@/lib/credits";
import { cn } from "@/lib/utils";

const QUICK_AMOUNTS = [100, 250, 500, 1000];

export function UpgradeDialog() {
  const { upgradeOpen, setUpgradeOpen } = useShell();
  const [amount, setAmount] = useState(String(MIN_TOP_UP_BDT));
  const [balance, setBalance] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    amount: number;
    requests: number;
  } | null>(null);

  useEffect(() => {
    if (!upgradeOpen) return;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (!alive) return;
      setAmount(String(MIN_TOP_UP_BDT));
      setBalance(readCreditBalance());
      setReceipt(null);
      setError(null);
      setPending(false);
    })();
    return () => {
      alive = false;
    };
  }, [upgradeOpen]);

  const parsed = Number(amount);
  const normalized = normalizeTopUp(parsed);
  const invalid = !Number.isFinite(parsed) || parsed < MIN_TOP_UP_BDT;

  async function topUp() {
    if (invalid || pending) {
      if (invalid) setError(`Minimum top-up is ${formatTaka(MIN_TOP_UP_BDT)}.`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await createTopUp(normalized);
      setBalance(result.balance);
      setReceipt({ amount: result.amount, requests: result.requests });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not add credits.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={upgradeOpen} onOpenChange={setUpgradeOpen}>
      <DialogContent className="max-w-md gap-5">
        <DialogHeader>
          <div className="mb-1 flex size-9 items-center justify-center rounded-xl border border-border bg-muted/50">
            <Sparkles className="size-4 text-foreground" />
          </div>
          <DialogTitle>Keep building</DialogTitle>
          <DialogDescription>
            You have reached today&apos;s AI request limit. Add credits or view
            plans to keep this conversation moving.
          </DialogDescription>
        </DialogHeader>

        {receipt ? (
          <div className="rounded-xl border border-border bg-surface p-4">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Check className="size-4" />
              Credits added
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {formatTaka(receipt.amount)} added to your demo wallet — about{" "}
              {receipt.requests.toLocaleString("en-US")} AI requests.
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Top-up amount</span>
                <span className="font-mono text-foreground/80">
                  Balance {formatTaka(balance)}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {QUICK_AMOUNTS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={normalized === value}
                    onClick={() => {
                      setAmount(String(value));
                      setError(null);
                    }}
                    className={cn(
                      "h-8 rounded-lg border font-mono text-[11px] transition-colors",
                      normalized === value
                        ? "border-foreground/30 bg-surface text-foreground"
                        : "border-border text-muted-foreground hover:border-foreground/20 hover:text-foreground",
                    )}
                  >
                    {formatTaka(value)}
                  </button>
                ))}
              </div>
              <div className="relative">
                <Wallet className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type="number"
                  inputMode="numeric"
                  min={MIN_TOP_UP_BDT}
                  step={50}
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setError(null);
                  }}
                  aria-label="Top-up amount in Bangladeshi taka"
                  className="h-10 pl-9 font-mono"
                />
                <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[11px] text-muted-foreground">
                  BDT
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {formatTaka(normalized)} buys about{" "}
                {requestsForAmount(normalized).toLocaleString("en-US")} AI
                requests · minimum {formatTaka(MIN_TOP_UP_BDT)}
              </p>
              {error ? (
                <p className="text-[11px] text-foreground">{error}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Button
                type="button"
                className="h-10 w-full"
                disabled={pending || invalid}
                onClick={() => void topUp()}
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : null}
                {pending
                  ? "Adding credits…"
                  : `Add ${formatTaka(normalized)}`}
              </Button>
              <Button
                variant="outline"
                className="h-9 w-full justify-between"
                render={<Link href="/pricing" />}
                nativeButton={false}
                onClick={() => setUpgradeOpen(false)}
              >
                Compare plans
                <ArrowRight className="size-3.5" />
              </Button>
            </div>
          </>
        )}

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Demo only — no real charges. Credits are stored in this browser.
        </p>
      </DialogContent>
    </Dialog>
  );
}
