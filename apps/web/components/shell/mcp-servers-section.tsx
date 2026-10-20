"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2, Plus } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { McpServerView } from "@/lib/mcp/types";

/**
 * Compact settings summary: how many servers are configured/enabled and a link
 * into the full management page at `/mcp`.
 */
export function McpServersSection({ open }: { open: boolean }) {
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const enabledCount = servers?.filter((server) => server.enabled).length ?? 0;

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          MCP servers
        </h3>
        <Button
          type="button"
          size="xs"
          variant="outline"
          render={<Link href="/mcp" />}
          nativeButton={false}
        >
          <Plus className="size-3" />
          Manage
        </Button>
      </div>
      {error ? (
        <p className="rounded-lg border border-border px-3 py-2 text-xs text-[var(--text)]">
          {error}
        </p>
      ) : servers === null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          Loading…
        </div>
      ) : (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {servers.length === 0
              ? "No servers configured."
              : `${enabledCount} of ${servers.length} server${
                  servers.length === 1 ? "" : "s"
                } enabled.`}{" "}
            Tools from Streamable HTTP servers are available to every run; auth
            headers are encrypted at rest.
          </p>
          {servers.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {servers.map((server) => (
                <Badge key={server.id} variant="outline" className="gap-1">
                  <span className={server.enabled ? "text-foreground" : "text-muted-foreground"}>
                    {server.name}
                  </span>
                  <ArrowUpRight className="size-2.5 text-muted-foreground" />
                </Badge>
              ))}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}