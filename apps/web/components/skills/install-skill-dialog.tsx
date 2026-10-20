"use client";

import { useState } from "react";
import { Download, FolderGit2, Loader2, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import type { SkillView } from "@/hooks/use-skills";

interface DiscoveredSkill {
  name: string;
  description: string;
  source: string;
  sourceKind: SkillView["sourceKind"];
  resolvedRef: string;
  digest: string;
  fileCount: number;
}

interface DiscoverResponse {
  candidates?: string[];
  skill?: DiscoveredSkill;
  error?: string;
  message?: string;
}

function sourceKindLabel(kind: SkillView["sourceKind"]): string {
  if (kind === "github") return "GitHub";
  if (kind === "url") return "URL";
  return "Archive";
}

function shorten(value: string, max = 32): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function discoverError(
  response: Response,
  data: { error?: string; message?: string },
): string {
  if (data.error === "schema_not_migrated") {
    return "Database migration required. Run the database migrations.";
  }
  return data.message ?? data.error ?? `Request failed (${response.status})`;
}

export function InstallSkillDialog({
  open,
  onOpenChange,
  onInstall,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (input: { source: string; path?: string }) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <InstallSkillForm
            onCancel={() => onOpenChange(false)}
            onInstall={onInstall}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InstallSkillForm({
  onCancel,
  onInstall,
}: {
  onCancel: () => void;
  onInstall: (input: { source: string; path?: string }) => Promise<void>;
}) {
  const [source, setSource] = useState("");
  const [path, setPath] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredSkill | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const busy = previewing || installing;

  async function preview(nextPath?: string) {
    if (!source.trim()) return;
    setPreviewing(true);
    setError(null);
    setDiscovered(null);
    setCandidates([]);
    const chosenPath = nextPath ?? path.trim();
    try {
      const response = await fetch("/api/skills/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: source.trim(),
          path: chosenPath || undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as DiscoverResponse;
      if (!response.ok) throw new Error(discoverError(response, data));
      setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
      setDiscovered(data.skill ?? null);
      if (nextPath) setPath(nextPath);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPreviewing(false);
    }
  }

  async function install() {
    if (!source.trim()) return;
    setInstalling(true);
    setError(null);
    try {
      await onInstall({
        source: source.trim(),
        path: path.trim() || undefined,
      });
      onCancel();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void install();
      }}
    >
      <DialogHeader>
        <DialogTitle>Install skill</DialogTitle>
        <DialogDescription>
          Accepts a GitHub repo (owner/repo or URL), a direct SKILL.md URL, or a
          .zip/.tar.gz archive. Installing only fetches and validates files — it
          never starts a workspace or runs scripts.
        </DialogDescription>
      </DialogHeader>

      <div className="mt-3 space-y-3">
        <div className="space-y-1.5">
          <label
            htmlFor="skill-source"
            className="text-xs font-medium text-muted-foreground"
          >
            Source
          </label>
          <Input
            id="skill-source"
            placeholder="owner/repo, GitHub URL, SKILL.md, .zip/.tar.gz"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={busy}
          />
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="skill-path"
            className="text-xs font-medium text-muted-foreground"
          >
            Path (optional)
          </label>
          <Input
            id="skill-path"
            placeholder="skills/my-skill or path inside the archive"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            disabled={busy}
          />
        </div>

        <Button
          type="button"
          size="xs"
          variant="outline"
          className="justify-center"
          disabled={busy || !source.trim()}
          onClick={() => void preview()}
        >
          {previewing ? (
            <Loader2 className="size-3 animate-spin motion-reduce:animate-none" />
          ) : (
            <Search className="size-3" />
          )}
          Preview
        </Button>

        {candidates.length > 0 ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              {candidates.length > 1
                ? "Multiple skill directories found. Choose one:"
                : "Skill directory found:"}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((candidate) => (
                <Button
                  key={candidate}
                  type="button"
                  size="xs"
                  variant={(candidate || "/") === path ? "secondary" : "outline"}
                  disabled={busy}
                  onClick={() => void preview(candidate || "/")}
                >
                  <FolderGit2 className="size-3" />
                  {candidate || "(root)"}
                </Button>
              ))}
            </div>
          </div>
        ) : null}

        {discovered ? (
          <div className="rounded-lg border border-border p-2.5">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-sm font-medium text-foreground">
                {discovered.name}
              </span>
              <Badge variant="outline" className="text-[10px]">
                {sourceKindLabel(discovered.sourceKind)}
              </Badge>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {discovered.description}
            </p>
            <p className="mt-1 truncate font-mono text-[10px] text-[var(--text-faint)]">
              {shorten(discovered.resolvedRef)} · {discovered.fileCount} file
              {discovered.fileCount === 1 ? "" : "s"}
            </p>
          </div>
        ) : null}

        {error ? (
          <p className="rounded-lg border border-border px-2.5 py-2 text-xs text-[var(--text)]">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter className="mt-4">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !source.trim()}>
          {installing ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Download className="size-3.5" />
          )}
          Install
        </Button>
      </DialogFooter>
    </form>
  );
}
