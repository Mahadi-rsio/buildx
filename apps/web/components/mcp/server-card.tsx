"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  Plug,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { McpServerView, McpToolInfo } from "@/lib/mcp/types";
import { cn } from "@/lib/utils";

function statusBadge(server: McpServerView) {
  if (!server.enabled) return <Badge variant="outline">Disabled</Badge>;
  if (server.lastStatus === "connected") {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="size-3" />
        Connected
      </Badge>
    );
  }
  if (server.lastStatus === "error") {
    return (
      <Badge variant="destructive" className="gap-1">
        <AlertTriangle className="size-3" />
        Error
      </Badge>
    );
  }
  return <Badge variant="outline">Not tested</Badge>;
}

export function ServerCard({
  server,
  busy,
  onToggle,
  onEdit,
  onDelete,
}: {
  server: McpServerView;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const loadTools = useCallback(async () => {
    setToolsLoading(true);
    setToolsError(null);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}/tools`, {
        cache: "no-store",
      });
      const data = (await response.json()) as {
        tools?: McpToolInfo[];
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(data.message ?? data.error ?? "Could not list tools");
      }
      setTools(data.tools ?? []);
    } catch (caught) {
      setToolsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setToolsLoading(false);
    }
  }, [server.id]);

  async function runTest() {
    setTesting(true);
    try {
      const response = await fetch(`/api/mcp/servers/${server.id}/test`, {
        method: "POST",
      });
      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        tools?: McpToolInfo[];
      };
      if (!response.ok || !data.ok) {
        throw new Error(data.message ?? "Connection failed");
      }
      setTools(data.tools ?? []);
      setToolsOpen(true);
    } catch (caught) {
      setToolsError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTesting(false);
    }
  }

  return (
    <li
      className={cn(
        "rounded-xl border border-border bg-card p-3 transition",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-[13px] text-foreground">
              {server.name}
            </span>
            {statusBadge(server)}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {server.url}
            {server.hasHeaders ? " · auth" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Test ${server.name}`}
            disabled={busy}
            onClick={() => void runTest()}
          >
            {testing ? (
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Plug className="size-3" />
            )}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Edit ${server.name}`}
            disabled={busy}
            onClick={onEdit}
          >
            <Pencil className="size-3" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Delete ${server.name}`}
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>

      {server.lastError ? (
        <p className="mt-1.5 line-clamp-2 text-xs text-[var(--text-faint)]">
          {server.lastError}
        </p>
      ) : null}

      <div className="mt-1.5 flex items-center gap-3">
        <label className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={server.enabled}
            disabled={busy}
            onChange={onToggle}
          />
          Enabled
        </label>
        <Collapsible
          open={toolsOpen}
          onOpenChange={(next) => {
            setToolsOpen(next);
            if (next && tools === null && !toolsLoading) void loadTools();
          }}
        >
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-expanded={toolsOpen}
                disabled={!server.enabled}
              >
                Tools
                {tools !== null ? ` (${tools.length})` : ""}
                <ChevronDown
                  className={cn(
                    "size-3 transition-transform",
                    toolsOpen && "rotate-180",
                  )}
                />
              </Button>
            }
          />
          <CollapsibleContent className="mt-2">
            {toolsLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
                Listing tools…
              </div>
            ) : toolsError ? (
              <p className="rounded-lg border border-border px-2.5 py-2 text-xs text-[var(--text)]">
                {toolsError}
              </p>
            ) : (tools ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">No tools exposed.</p>
            ) : (
              <ul className="space-y-1">
                {(tools ?? []).map((tool) => (
                  <li
                    key={tool.name}
                    className="rounded-lg border border-border px-2.5 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-[11px] text-foreground">
                        {tool.name}
                      </span>
                      {tool.annotations?.destructiveHint ? (
                        <Badge variant="outline" className="text-[10px]">
                          Destructive
                        </Badge>
                      ) : null}
                    </div>
                    {tool.description ? (
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                        {tool.description}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  );
}