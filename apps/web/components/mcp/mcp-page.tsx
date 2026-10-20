"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plus, ServerCog } from "lucide-react";
import type { McpCatalogEntry } from "@buildx/shared";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CatalogConnectDialog } from "@/components/mcp/catalog-connect-dialog";
import { ServerCard } from "@/components/mcp/server-card";
import { ServerFormDialog } from "@/components/mcp/server-form";
import { popularCatalog } from "@/lib/mcp/catalog";
import type { McpServerView } from "@/lib/mcp/types";

function authLabel(entry: McpCatalogEntry): string {
  if (!entry.apiKeyHeader) return "No key required";
  return entry.apiKeyPrefix ? "API key (Bearer)" : "API key";
}

export function McpPage() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<McpCatalogEntry | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/mcp/servers", { cache: "no-store" });
        const data = (await response.json()) as {
          servers?: McpServerView[];
          error?: string;
          message?: string;
        };
        if (cancelled) return;
        if (!response.ok) {
          throw new Error(data.message ?? data.error ?? "Could not load servers");
        }
        setServers(data.servers ?? []);
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    const response = await fetch("/api/mcp/servers", { cache: "no-store" });
    const data = (await response.json()) as {
      servers?: McpServerView[];
      message?: string;
    };
    if (response.ok) {
      setServers(data.servers ?? []);
      setError(null);
    } else {
      setError(data.message ?? "Could not load servers");
    }
  }

  async function handleToggle(server: McpServerView) {
    setBusyId(server.id);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !server.enabled }),
      });
      if (!response.ok) throw new Error("Could not update server");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(server: McpServerView) {
    setBusyId(server.id);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}`, {
        method: "DELETE",
      });
      if (!response.ok && response.status !== 404) {
        throw new Error("Could not delete server");
      }
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyId(null);
    }
  }

  const isMigrated = !error?.toLowerCase().includes("migration");
  const installedCatalogIds = new Set(
    (servers ?? [])
      .map((server) => server.catalogId)
      .filter((id): id is string => Boolean(id)),
  );
  const popular = popularCatalog();

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-5 overflow-y-auto px-4 py-6 sm:px-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-lg font-medium text-foreground">
            MCP servers
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Connect Streamable HTTP servers so their tools are available to every
            run. Auth headers are encrypted at rest; destructive tools stay
            blocked. Disable a server to remove its tools from future runs.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          disabled={!isMigrated}
        >
          <Plus className="size-3.5" />
          Add server
        </Button>
      </header>

      {error ? (
        <Alert variant={isMigrated ? "default" : "destructive"}>
          <ServerCog />
          <AlertTitle>
            {isMigrated ? "Something went wrong" : "Database migration required"}
          </AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Popular
          </h2>
          <span className="text-[11px] text-muted-foreground">
            Connect with an API key or keyless
          </span>
        </div>
        <ul className="grid gap-2 sm:grid-cols-2">
          {popular.map((entry) => {
            const installed = installedCatalogIds.has(entry.id);
            return (
              <li
                key={entry.id}
                className="flex flex-col rounded-xl border border-border bg-card p-3"
              >
                <div className="flex items-start gap-2.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-white p-1.5">
                    {entry.logo ? (
                      <img
                        src={entry.logo}
                        alt=""
                        aria-hidden
                        loading="lazy"
                        className="size-full object-contain"
                      />
                    ) : (
                      <span aria-hidden className="text-base">
                        {entry.icon}
                      </span>
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {entry.name}
                      </span>
                      {entry.verified ? (
                        <Badge variant="secondary" className="text-[10px]">
                          Verified
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {entry.summary}
                    </p>
                  </div>
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-3">
                  <span className="text-[11px] text-muted-foreground">
                    {authLabel(entry)}
                  </span>
                  {installed ? (
                    <Badge variant="secondary" className="gap-1">
                      <CheckCircle2 className="size-3" />
                      Connected
                    </Badge>
                  ) : (
                    <Button
                      type="button"
                      size="xs"
                      onClick={() => setConnecting(entry)}
                      disabled={!isMigrated}
                    >
                      Connect
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Your servers
        </h2>
        {servers === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading servers…
          </div>
        ) : servers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <ServerCog className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-foreground">No MCP servers yet</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Connect a popular server above, or add any Streamable HTTP URL.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                busy={busyId === server.id}
                onToggle={() => void handleToggle(server)}
                onEdit={() => {
                  setEditing(server);
                  setFormOpen(true);
                }}
                onDelete={() => void handleDelete(server)}
              />
            ))}
          </ul>
        )}
      </section>

      <ServerFormDialog
        open={formOpen}
        server={editing}
        onOpenChange={setFormOpen}
        onSaved={refresh}
        onError={setError}
      />

      <CatalogConnectDialog
        entry={connecting}
        open={connecting !== null}
        onOpenChange={(open) => {
          if (!open) setConnecting(null);
        }}
        onSaved={refresh}
      />
    </div>
  );
}
