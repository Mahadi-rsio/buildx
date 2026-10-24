"use client";

import { type FormEvent, useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, Plus, Server, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface WorkspaceOption {
  id: string;
  name: string;
  status: "provisioning" | "ready" | "failed" | "recovering" | "deleting" | string;
  provisioned: boolean;
}

const TIERS = [
  { id: "small", name: "Small", ram: "4 GB RAM", storage: "5 GB storage", price: "$0.135", available: true },
  { id: "medium", name: "Medium", ram: "8 GB RAM", storage: "10 GB storage", price: "$0.27", available: false },
  { id: "large", name: "Large", ram: "16 GB RAM", storage: "20 GB storage max (25 GB unavailable)", price: "$0.54", available: false },
] as const;

export function WorkspaceManager({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (workspace: WorkspaceOption | null) => void;
}) {
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await fetch("/api/workspaces", { cache: "no-store" });
        const data = (await res.json().catch(() => ({}))) as { workspaces?: WorkspaceOption[]; message?: string };
        if (!res.ok) throw new Error(data.message ?? "Could not load workspaces.");
        if (!alive) return;
        const items = Array.isArray(data.workspaces) ? data.workspaces : [];
        setWorkspaces(items);
        const next = items.find((item) => item.id === selectedId && item.status === "ready")
          ?? items.find((item) => item.status === "ready")
          ?? null;
        onSelect(next);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : "Could not load workspaces.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // Initial hydration only; selection updates are handled by the select control.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating || name.trim().length < 2) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), size: "small" }),
      });
      const data = (await res.json().catch(() => ({}))) as { workspace?: WorkspaceOption; message?: string };
      if (!res.ok || !data.workspace) throw new Error(data.message ?? "Workspace creation failed.");
      setWorkspaces((current) => {
        const next = current.filter((item) => item.id !== data.workspace!.id);
        return [...next, data.workspace!];
      });
      onSelect(data.workspace);
      setName("");
      setShowCreate(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workspace creation failed.");
    } finally {
      setCreating(false);
    }
  }

  const noWorkspace = !loading && workspaces.length === 0;

  return (
    <section className={noWorkspace ? "mx-auto w-full max-w-2xl rounded-2xl border border-border bg-card p-5 sm:p-7" : "mb-5 rounded-xl border border-border/70 bg-[var(--surface)]/50 p-3"}>
      {noWorkspace ? (
        <>
          <div className="mb-5 flex size-10 items-center justify-center rounded-xl border border-border bg-background">
            <Server className="size-5" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Give your workspace a name. BuildX will provision a private, persistent Box for your files and agent sessions.
          </p>
          <form onSubmit={createWorkspace} className="mt-5 space-y-4">
            <label className="block space-y-1.5 text-sm font-medium">
              Workspace name
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. my-first-project" maxLength={40} autoFocus required minLength={2} />
            </label>
            <TierCards />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={creating || name.trim().length < 2}>
              {creating ? <><Loader2 className="mr-2 size-4 animate-spin" />Creating workspace and Box…</> : <><Plus className="mr-2 size-4" />Create workspace</>}
            </Button>
          </form>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Server className="size-4 shrink-0 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">Workspace</span>
            {loading ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading…</span>
            ) : (
              <div className="relative min-w-0 flex-1 sm:max-w-xs">
                <select
                  aria-label="Select workspace"
                  className="h-9 w-full appearance-none rounded-md border border-input bg-background px-3 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={selectedId ?? ""}
                  onChange={(event) => onSelect(workspaces.find((item) => item.id === event.target.value) ?? null)}
                >
                  {workspaces.map((item) => <option key={item.id} value={item.id} disabled={item.status !== "ready"}>{item.name}{item.status !== "ready" ? ` · ${item.status}` : ""}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-2xs text-muted-foreground">
              <Check className="size-3" />4 GB RAM · 5 GB storage
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => { setShowCreate(true); setError(null); }}>
              <Plus className="mr-1.5 size-3.5" />New
            </Button>
          </div>
          {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
        </>
      )}

      {showCreate ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) setShowCreate(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="workspace-create-title" className="w-full max-w-lg rounded-2xl border border-border bg-background p-5 shadow-xl sm:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 id="workspace-create-title" className="text-lg font-semibold">New workspace</h2>
                <p className="mt-1 text-sm text-muted-foreground">Each workspace gets its own durable Box.</p>
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={() => setShowCreate(false)} disabled={creating}><X className="size-4" /></Button>
            </div>
            <form onSubmit={createWorkspace} className="mt-4 space-y-4">
              <label className="block space-y-1.5 text-sm font-medium">
                Workspace name
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. api-redesign" maxLength={40} required minLength={2} />
              </label>
              <TierCards />
              {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
              <Button type="submit" className="w-full" disabled={creating || name.trim().length < 2}>
                {creating ? <><Loader2 className="mr-2 size-4 animate-spin" />Provisioning Box…</> : "Create workspace"}
              </Button>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TierCards() {
  return (
    <div className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-3">
        {TIERS.map((tier) => (
          <div
            key={tier.id}
            className={
              tier.available
                ? "rounded-xl border border-foreground/30 bg-muted/30 p-3"
                : "rounded-xl border border-border/60 bg-muted/20 p-3 opacity-60"
            }
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">{tier.name}</span>
              {tier.available ? (
                <span className="rounded-full bg-foreground px-2 py-0.5 text-2xs text-background">
                  Free tier
                </span>
              ) : (
                <span className="text-2xs text-muted-foreground">Paid plan</span>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{tier.ram}</p>
            <p className="text-xs text-muted-foreground">{tier.storage}</p>
            <p className="mt-3 font-mono text-sm font-semibold">
              {tier.price}
              <span className="font-sans text-2xs font-normal text-muted-foreground">
                {" "}/ active CPU-hour
              </span>
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">
              Upstash base rate + 35% BuildX markup
            </p>
          </div>
        ))}
      </div>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Upstash Free includes 5 CPU-hours per month. Rates shown are BuildX unit
        rates per active CPU-hour, not wall-clock hours; provider plan limits still apply.
      </p>
    </div>
  );
}
