"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Plug, ShieldAlert } from "lucide-react";
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
import type { McpServerView, McpToolInfo } from "@/lib/mcp/types";

type AuthType = "none" | "bearer";

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(":");
    if (index <= 0) {
      throw new Error(`Invalid header line "${trimmed}" (use Name: value)`);
    }
    headers[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return headers;
}

export function ServerFormDialog({
  open,
  server,
  onOpenChange,
  onSaved,
  onError,
}: {
  open: boolean;
  server: McpServerView | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  onError: (error: string | null) => void;
}) {
  // Remount the inner form whenever the dialog opens or the target server
  // changes, so each open starts from the stored values without syncing state
  // from props inside an effect.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <ServerFormFields
            key={server?.id ?? "new"}
            server={server}
            onSaved={onSaved}
            onError={onError}
            onCancel={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ServerFormFields({
  server,
  onSaved,
  onError,
  onCancel,
}: {
  server: McpServerView | null;
  onSaved: () => Promise<void>;
  onError: (error: string | null) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [url, setUrl] = useState(server?.url ?? "");
  const [authType, setAuthType] = useState<AuthType>("none");
  const [bearerToken, setBearerToken] = useState("");
  const [extraHeaders, setExtraHeaders] = useState("");
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [allowPrivate, setAllowPrivate] = useState(server?.allowPrivate ?? false);
  const [allowPrivateEnabled, setAllowPrivateEnabled] = useState(false);
  const [clearCredentials, setClearCredentials] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testState, setTestState] = useState<
    | { status: "idle" }
    | { status: "ok"; tools: McpToolInfo[] }
    | { status: "error"; message: string }
  >({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/config", { cache: "no-store" });
        const config = (await response.json()) as {
          allowPrivateMcpHosts?: boolean;
        };
        if (!cancelled) {
          setAllowPrivateEnabled(config.allowPrivateMcpHosts === true);
        }
      } catch {
        // Private-host toggle simply stays hidden if config is unreachable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function buildHeaders(): Record<string, string> {
    const headers = parseHeaders(extraHeaders);
    if (authType === "bearer" && bearerToken.trim()) {
      headers["Authorization"] = `Bearer ${bearerToken.trim()}`;
    }
    return headers;
  }

  async function runTest() {
    setTesting(true);
    setTestState({ status: "idle" });
    try {
      const response = await fetch("/api/mcp/servers/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim() || "test",
          url,
          headers: buildHeaders(),
          allowPrivate,
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

  async function save() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: name.trim(),
        url: url.trim(),
        enabled,
        allowPrivate,
      };
      if (server) {
        if (clearCredentials) {
          payload.headers = {};
        } else {
          const headers = buildHeaders();
          if (Object.keys(headers).length > 0) payload.headers = headers;
        }
      } else {
        const headers = buildHeaders();
        if (Object.keys(headers).length > 0) payload.headers = headers;
      }
      const response = await fetch(
        server ? `/api/mcp/servers/${server.id}` : "/api/mcp/servers",
        {
          method: server ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(data.message ?? data.error ?? "Could not save server");
      }
      onError(null);
      onCancel();
      await onSaved();
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  const canSubmit = name.trim().length > 0 && url.trim().length > 0;

  return (
    <>
      <DialogHeader>
          <DialogTitle>{server ? "Edit server" : "Add MCP server"}</DialogTitle>
          <DialogDescription>
            Streamable HTTP servers only. Credentials are encrypted at rest and
            never shown after saving.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              placeholder="e.g. Linear"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              URL
            </label>
            <Input
              placeholder="https://mcp.example.com/mcp"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Auth
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  authType === "none"
                    ? "border-ring bg-muted text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setAuthType("none")}
              >
                None
              </button>
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  authType === "bearer"
                    ? "border-ring bg-muted text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
                onClick={() => setAuthType("bearer")}
              >
                Bearer token
              </button>
            </div>
            {authType === "bearer" ? (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={
                  server?.hasHeaders
                    ? "Saved credentials kept — type to replace"
                    : "Bearer token"
                }
                value={bearerToken}
                onChange={(event) => setBearerToken(event.target.value)}
              />
            ) : null}
            <textarea
              placeholder={"X-API-Key: …\nX-Custom: …"}
              value={extraHeaders}
              onChange={(event) => setExtraHeaders(event.target.value)}
              rows={2}
              className="w-full resize-y rounded-lg border border-border bg-transparent px-2.5 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            {server?.hasHeaders && authType !== "bearer" ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearCredentials}
                  onChange={(event) => setClearCredentials(event.target.checked)}
                />
                Remove saved credentials
              </label>
            ) : null}
          </div>

          {allowPrivateEnabled ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={allowPrivate}
                onChange={(event) => setAllowPrivate(event.target.checked)}
              />
              Allow private/loopback hosts (local development only)
            </label>
          ) : null}

          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Enabled (tools available to new runs)
          </label>

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void runTest()}
              disabled={testing || !url.trim()}
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
                {testState.tools.slice(0, 3).map((tool) => tool.name).join(", ")}
                {testState.tools.length > 3 ? "…" : ""}
              </p>
            ) : testState.status === "error" ? (
              <p className="flex items-start gap-1.5 text-xs text-[var(--text)]">
                <ShieldAlert className="mt-0.5 size-3 shrink-0" />
                {testState.message}
              </p>
            ) : null}
          </div>
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
            onClick={() => void save()}
            disabled={!canSubmit || saving}
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : null}
            {server ? "Save changes" : "Add server"}
          </Button>
        </DialogFooter>
    </>
  );
}