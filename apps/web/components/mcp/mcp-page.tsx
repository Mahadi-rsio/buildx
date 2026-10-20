"use client";

import { useEffect, useState } from "react";
import { Loader2, Plus, ServerCog } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ServerCard } from "@/components/mcp/server-card";
import { ServerFormDialog } from "@/components/mcp/server-form";
import type { McpServerView } from "@/lib/mcp/types";

export function McpPage() {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-5 px-4 py-6 sm:px-6">
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
            Add a Streamable HTTP server to expose its tools to the agent.
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

      <ServerFormDialog
        open={formOpen}
        server={editing}
        onOpenChange={setFormOpen}
        onSaved={refresh}
        onError={setError}
      />
    </div>
  );
}