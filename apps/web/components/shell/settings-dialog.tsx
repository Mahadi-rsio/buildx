"use client";

import { AlertTriangle, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { useConfig } from "@/hooks/use-config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useShell } from "@/components/shell/shell-context";

function EnvRow({
  label,
  ok,
  value,
}: {
  label: string;
  ok: boolean | null;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
      <div className="min-w-0">
        <p className="font-mono text-[11px] text-foreground">{label}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{value}</p>
      </div>
      {ok === null ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      ) : ok ? (
        <CheckCircle2 className="size-4 shrink-0 text-emerald-400" />
      ) : (
        <AlertTriangle className="size-4 shrink-0 text-amber-300" />
      )}
    </div>
  );
}

export function SettingsDialog() {
  const { config, loading, error } = useConfig();
  const { settingsOpen, setSettingsOpen, modelOverride, setModelOverride } =
    useShell();

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Environment and workspace for this dashboard. Keys stay on the
            server — nothing here is editable at runtime.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agent environment
            </h3>
            {error ? (
              <p className="text-xs text-red-400">{error}</p>
            ) : loading || !config ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                Reading /api/config…
              </div>
            ) : (
              <div className="space-y-2">
                <EnvRow
                  label="OPENAI_API_KEY"
                  ok={config.hasApiKey}
                  value={
                    config.hasApiKey
                      ? "Configured"
                      : "Missing — copy .env.example to .env.local"
                  }
                />
                <EnvRow
                  label="OPENAI_BASE_URL"
                  ok={config.baseURL !== null}
                  value={config.baseURL ?? "OpenAI default"}
                />
                <EnvRow
                  label="AGENT_MODEL"
                  ok
                  value={`${config.model} · max ${config.maxSteps} steps`}
                />
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Default model override
            </h3>
            <input
              value={modelOverride}
              onChange={(e) => setModelOverride(e.target.value)}
              placeholder={config ? config.model : "model id"}
              aria-label="Default model override"
              className="h-9 w-full rounded-lg border border-border bg-muted/40 px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring/50"
            />
            <p className="text-xs text-muted-foreground">
              Prefills the composer on new runs. A run&apos;s actual model is
              fixed when it starts and shown in the top bar.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Workspace
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Each run gets an isolated scratch workspace at{" "}
              <code className="font-mono text-foreground/80">
                apps/web/.workspaces/&lt;runId&gt;
              </code>
              . The agent runs outside the sandbox; keys never enter it.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Integrations
            </h3>
            <div className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
              MCP servers, preview URLs, and steering mid-run are not wired in
              this phase. Tabs that reference them say so instead of faking a
              connection.
            </div>
            <a
              href="https://github.com/anomalyco/opencode/issues"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-sky-300 hover:underline"
            >
              Report an issue
              <ExternalLink className="size-3" />
            </a>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
