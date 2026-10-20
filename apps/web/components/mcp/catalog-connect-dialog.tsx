"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plug,
  ShieldAlert,
} from "lucide-react";
import type { McpCatalogEntry } from "@buildx/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { catalogAuthHeaders } from "@/lib/mcp/catalog";
import type { McpToolInfo } from "@/lib/mcp/types";

/**
 * Install form for a curated catalog entry. Keyless entries connect with just
 * the prefilled name/URL; API-key entries collect the key and map it onto the
 * provider's declared header. Credentials are only sent to the server, which
 * encrypts them at rest.
 */
export function CatalogConnectDialog({
  entry,
  open,
  onOpenChange,
  onSaved,
}: {
  entry: McpCatalogEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && entry ? (
          <CatalogConnectFields
            key={entry.id}
            entry={entry}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CatalogConnectFields({
  entry,
  onSaved,
  onCancel,
}: {
  entry: McpCatalogEntry;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const needsApiKey = Boolean(entry.apiKeyHeader);
  const [name, setName] = useState(entry.name);
  const [url, setUrl] = useState(entry.endpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testState, setTestState] = useState<
    | { status: "idle" }
    | { status: "ok"; tools: McpToolInfo[] }
    | { status: "error"; message: string }
  >({ status: "idle" });

  const authHint = needsApiKey
    ? `Sent as ${entry.apiKeyHeader}${
        entry.apiKeyPrefix ? ` with the "${entry.apiKeyPrefix.trim()}" prefix` : ""
      }.`
    : "No API key required — connect as-is.";

  const canSubmit =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    (!needsApiKey || apiKey.trim().length > 0);

  function buildHeaders(): Record<string, string> {
    return catalogAuthHeaders(entry, apiKey);
  }

  async function runTest() {
    setTesting(true);
    setTestState({ status: "idle" });
    setError(null);
    try {
      const response = await fetch("/api/mcp/servers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || entry.name,
          url: url.trim(),
          headers: buildHeaders(),
        }),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        tools?: McpToolInfo[];
        message?: string;
      };
      if (!response.ok || !data.ok) {
        throw new Error(data.message ?? "Connection failed");
      }
      setTestState({ status: "ok", tools: data.tools ?? [] });
    } catch (caught) {
      setTestState({
        status: "error",
        message: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setTesting(false);
    }
  }

  async function connect() {
    setSaving(true);
    setError(null);
    try {
      const headers = buildHeaders();
      const response = await fetch("/api/mcp/servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          catalogId: entry.id,
          enabled: true,
        }),
      });
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(data.message ?? data.error ?? "Could not connect server");
      }
      await onSaved();
      onCancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect {entry.name}</DialogTitle>
        <DialogDescription>{entry.summary}</DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {entry.description}
        </p>

        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            Name
          </label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">
            URL
          </label>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} />
        </div>

        {needsApiKey ? (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              API key
            </label>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder={`${entry.name} API key`}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">{authHint}</p>
              <a
                href={entry.officialUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Get a key
                <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{authHint}</p>
        )}

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void runTest()}
            disabled={testing || saving || !canSubmit}
            className="justify-center"
          >
            {testing ? (
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
            ) : (
              <Plug className="size-3" />
            )}
            Test connection
          </Button>
          {testState.status === "ok" ? (
            <p className="flex items-start gap-1.5 text-xs text-[var(--text-muted)]">
              <CheckCircle2 className="mt-0.5 size-3 shrink-0" />
              Connected — {testState.tools.length} tool
              {testState.tools.length === 1 ? "" : "s"} exposed.
              {testState.tools
                .slice(0, 3)
                .map((tool) => tool.name)
                .join(", ")}
              {testState.tools.length > 3 ? "…" : ""}
            </p>
          ) : testState.status === "error" ? (
            <p className="flex items-start gap-1.5 text-xs text-[var(--text)]">
              <ShieldAlert className="mt-0.5 size-3 shrink-0" />
              {testState.message}
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-lg border border-border px-2.5 py-2 text-xs text-[var(--text)]">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={() => void connect()}
          disabled={!canSubmit || saving}
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : null}
          Connect
        </Button>
      </DialogFooter>
    </>
  );
}
