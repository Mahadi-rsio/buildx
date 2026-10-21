"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Download,
  Eye,
  FileText,
  FolderGit2,
  Loader2,
  Search,
  ShieldCheck,
} from "lucide-react";
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
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import type { InstallResult, SkillView } from "@/hooks/use-skills";
import {
  duplicateCandidateNames,
  filterSkillCandidates,
  selectedCandidates,
  selectAllValid,
  toggleSelected,
} from "@/lib/skills/selection";
import { cn } from "@/lib/utils";

interface Candidate {
  path: string;
  name: string;
  description: string;
  fileCount: number;
  valid: boolean;
  error?: string;
}

interface PreviewDetail {
  name: string;
  description: string;
  source: string;
  sourceKind: SkillView["sourceKind"];
  resolvedRef: string;
  digest: string;
  fileCount: number;
  instructions: string;
  files: string[];
}

interface DiscoverResponse {
  candidates?: string[];
  skills?: Candidate[];
  skill?: PreviewDetail;
  error?: string;
  message?: string;
}

const STAGES = ["Source", "Preview", "Select skills", "Install"] as const;

function sourceKindLabel(kind: SkillView["sourceKind"]): string {
  if (kind === "github") return "GitHub";
  if (kind === "url") return "URL";
  return "Archive";
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path || "root";
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

function message(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function InstallSkillDialog({
  open,
  onOpenChange,
  onInstall,
  installed = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: (input: {
    source: string;
    path?: string;
    paths?: string[];
    overwrite?: boolean;
  }) => Promise<InstallResult>;
  installed?: SkillView[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[calc(100dvh-2rem)]">
        {open ? (
          <InstallSkillForm
            installed={installed}
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
  installed,
}: {
  onCancel: () => void;
  onInstall: (input: {
    source: string;
    path?: string;
    paths?: string[];
    overwrite?: boolean;
  }) => Promise<InstallResult>;
  installed: SkillView[];
}) {
  const [source, setSource] = useState("");
  const [path, setPath] = useState("");
  const [discoveredSource, setDiscoveredSource] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewDetail | null>(null);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);

  const busy = loading || installing;
  const stale = discoveredSource !== null && discoveredSource !== source.trim();
  const duplicates = useMemo(
    () => duplicateCandidateNames(candidates, installed),
    [candidates, installed],
  );
  const visibleCandidates = useMemo(
    () => filterSkillCandidates(candidates, search),
    [candidates, search],
  );
  const chosen = useMemo(
    () => selectedCandidates(candidates, selected),
    [candidates, selected],
  );
  const selectedCount = chosen.length;
  const selectedDuplicates = chosen.filter((candidate) =>
    duplicates.has(candidate.name),
  ).length;

  const step = result
    ? 3
    : installing
      ? 3
      : preview
        ? 2
        : candidates.length > 0
          ? 2
          : loading
            ? 1
            : 0;

  function resetDiscovery() {
    setCandidates([]);
    setSelected(new Set());
    setPreview(null);
    setPreviewPath(null);
    setSearch("");
    setResult(null);
    setError(null);
    setInstallError(null);
    setDiscoveredSource(null);
  }

  async function discover() {
    const trimmed = source.trim();
    if (!trimmed || busy) return;
    setLoading(true);
    setError(null);
    setInstallError(null);
    setResult(null);
    setPreview(null);
    setPreviewPath(null);
    setCandidates([]);
    setSelected(new Set());
    const chosenPath = path.trim();
    try {
      const response = await fetch("/api/skills/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: trimmed,
          path: chosenPath || undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as DiscoverResponse;
      if (!response.ok) throw new Error(discoverError(response, data));

      const nextCandidates: Candidate[] =
        Array.isArray(data.skills) && data.skills.length > 0
          ? data.skills
          : (Array.isArray(data.candidates) ? data.candidates : []).map(
              (candidatePath) => ({
                path: candidatePath,
                name: basename(candidatePath),
                description: "",
                fileCount: 0,
                valid: true,
              }),
            );
      if (nextCandidates.length === 0) {
        throw new Error(
          "No SKILL.md files were found. Check the repository and optional path.",
        );
      }

      setCandidates(nextCandidates);
      setDiscoveredSource(trimmed);
      if (chosenPath) {
        const match = nextCandidates.find(
          (candidate) =>
            candidate.path === chosenPath ||
            candidate.path.endsWith(`/${chosenPath}`),
        );
        setSelected(match && match.valid ? new Set([match.path]) : new Set());
      } else {
        setSelected(selectAllValid(nextCandidates));
      }
      if (data.skill) {
        setPreview(data.skill);
        setPreviewPath(
          chosenPath ||
            nextCandidates.find((candidate) => candidate.name === data.skill?.name)
              ?.path ||
            (nextCandidates.length === 1 ? nextCandidates[0].path : ""),
        );
      }
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoading(false);
    }
  }

  async function inspect(candidate: Candidate) {
    if (!candidate.valid || busy || !source.trim()) return;
    setLoading(true);
    setError(null);
    setInstallError(null);
    try {
      const response = await fetch("/api/skills/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: source.trim(),
          path: candidate.path || undefined,
        }),
      });
      const data = (await response.json().catch(() => ({}))) as DiscoverResponse;
      if (!response.ok) throw new Error(discoverError(response, data));
      if (!data.skill) {
        throw new Error(
          data.message ?? "The selected path does not contain a valid skill.",
        );
      }
      setPreview(data.skill);
      setPreviewPath(candidate.path);
      if (Array.isArray(data.skills) && data.skills.length > 0) {
        setCandidates(data.skills);
      }
    } catch (caught) {
      setError(message(caught));
    } finally {
      setLoading(false);
    }
  }

  async function install() {
    const trimmed = source.trim();
    if (!trimmed || busy || result) return;
    if (stale) {
      setError("Preview the source again after editing it.");
      return;
    }
    if (chosen.length === 0) {
      setError("Select at least one valid skill to install.");
      return;
    }
    setInstalling(true);
    setInstallError(null);
    try {
      const next = await onInstall({
        source: trimmed,
        paths: chosen.map((candidate) => candidate.path),
        overwrite,
      });
      setResult(next);
    } catch (caught) {
      setInstallError(message(caught));
    } finally {
      setInstalling(false);
    }
  }

  function installAnother() {
    resetDiscovery();
    setOverwrite(false);
    setSource("");
    setPath("");
  }

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        if (result) return;
        if (stale || candidates.length === 0) void discover();
        else void install();
      }}
    >
      <div className="shrink-0 border-b border-border px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <DialogHeader className="pr-9">
          <div className="flex flex-wrap items-center gap-2">
            <DialogTitle>Install skills</DialogTitle>
            <Badge variant="outline" className="text-[10px]">
              Agent Skills
            </Badge>
          </div>
          <DialogDescription className="text-xs leading-relaxed">
            Inspect a GitHub repository, SKILL.md URL, or archive. Nothing runs
            here — files are fetched, validated, and stored for your agent.
          </DialogDescription>
        </DialogHeader>

        <ol
          className="mt-3 flex items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Install progress"
        >
          {STAGES.map((label, index) => (
            <li key={label} className="flex shrink-0 items-center gap-1">
              <span
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                  index < step && "border-border text-muted-foreground",
                  index === step &&
                    "border-foreground/25 bg-muted/60 text-foreground",
                  index > step && "border-transparent text-[var(--text-faint)]",
                )}
              >
                <span className="tabular-nums">{index + 1}</span>
                {label}
              </span>
              {index < STAGES.length - 1 ? (
                <span className="text-[10px] text-[var(--text-faint)]">/</span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
        {result ? (
          <SuccessState result={result} candidates={candidates} />
        ) : (
          <div className="space-y-4">
            <section className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="skill-source"
                  className="text-xs font-medium text-foreground"
                >
                  Repository or source
                </label>
                <span className="text-[10px] text-muted-foreground">
                  GitHub · URL · zip/tar.gz
                </span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="skill-source"
                  placeholder="mattpocock/skills or https://github.com/…"
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void discover();
                    }
                  }}
                  disabled={busy}
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  className="h-10 min-w-0 flex-1 font-mono text-sm"
                />
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-10 w-full shrink-0 sm:w-auto"
                  disabled={busy || !source.trim()}
                  onClick={() => void discover()}
                >
                  {loading ? (
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Search className="size-3.5" />
                  )}
                  {loading ? "Inspecting…" : "Preview"}
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Try{" "}
                <span className="font-mono text-foreground/80">
                  mattpocock/skills
                </span>
                . Preview lists every skill in the repo so you can choose.
              </p>
            </section>

            <section className="space-y-1.5">
              <label
                htmlFor="skill-path"
                className="text-xs font-medium text-foreground"
              >
                Path inside the source{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </label>
              <Input
                id="skill-path"
                placeholder="skills/engineering/code-review"
                value={path}
                onChange={(event) => {
                  setPath(event.target.value);
                  setError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void discover();
                  }
                }}
                disabled={busy}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                className="h-9 font-mono text-xs"
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Leave blank to select from all detected skills. Use it to jump
                straight to one directory or SKILL.md inside an archive.
              </p>
            </section>

            {loading && candidates.length === 0 ? (
              <LoadingState />
            ) : null}

            {error ? <ErrorState message={error} onRetry={discover} /> : null}

            {!loading && candidates.length === 0 && !error ? <IdleState /> : null}

            {preview ? (
              <PreviewPanel
                preview={preview}
                path={previewPath}
                candidates={candidates}
                selectedCount={selectedCount}
                installed={duplicates.has(preview.name)}
                onBack={() => {
                  setPreview(null);
                  setPreviewPath(null);
                }}
              />
            ) : candidates.length > 0 ? (
              <SelectionPanel
                candidates={candidates}
                visible={visibleCandidates}
                selected={selected}
                search={search}
                duplicates={duplicates}
                selectedCount={selectedCount}
                selectedDuplicates={selectedDuplicates}
                overwrite={overwrite}
                busy={busy}
                stale={stale}
                onSearch={setSearch}
                onToggle={(candidate) =>
                  setSelected((current) => toggleSelected(current, candidate.path))
                }
                onSelectAll={() => setSelected(selectAllValid(candidates))}
                onClear={() => setSelected(new Set())}
                onInspect={(candidate) => void inspect(candidate)}
                onOverwrite={setOverwrite}
              />
            ) : null}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-popover px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">
        {installError && !result ? (
          <div
            role="alert"
            aria-live="assertive"
            className="mb-2 flex items-start gap-2 rounded-lg border border-border bg-destructive/5 px-2.5 py-2"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-foreground" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">Install failed</p>
              <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted-foreground">
                {installError}
              </p>
            </div>
          </div>
        ) : null}
        <DialogFooter className="gap-2">
          {result ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="h-9 w-full sm:w-auto"
                onClick={installAnother}
              >
                Install another
              </Button>
              <Button
                type="button"
                className="h-9 w-full sm:w-auto"
                onClick={onCancel}
              >
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-full sm:w-auto"
                onClick={onCancel}
                disabled={installing}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-9 w-full sm:w-auto"
                disabled={
                  busy ||
                  stale ||
                  chosen.length === 0 ||
                  candidates.length === 0
                }
              >
                {installing ? (
                  <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {installing
                  ? `Installing ${selectedCount}…`
                  : selectedCount > 1
                    ? `Install ${selectedCount} skills`
                    : "Install skill"}
              </Button>
            </>
          )}
        </DialogFooter>
      </div>
    </form>
  );
}

function IdleState() {
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-6 text-center">
      <FolderGit2 className="mx-auto size-5 text-muted-foreground" />
      <p className="mt-2 text-sm font-medium text-foreground">
        Preview a source to begin
      </p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
        We read the repository tree or archive, validate every SKILL.md, and show
        the skills before anything is installed.
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/20 px-3 py-3"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          Fetching and validating skills…
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Reading the source tree and each SKILL.md.
        </p>
      </div>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div
      className="rounded-xl border border-border bg-destructive/5 px-3 py-3"
      role="alert"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">
            Couldn’t load this source
          </p>
          <p className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground">
            {message}
          </p>
        </div>
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        className="mt-2"
        onClick={onRetry}
      >
        Try again
      </Button>
    </div>
  );
}

function SelectionPanel({
  candidates,
  visible,
  selected,
  search,
  duplicates,
  selectedCount,
  selectedDuplicates,
  overwrite,
  busy,
  stale,
  onSearch,
  onToggle,
  onSelectAll,
  onClear,
  onInspect,
  onOverwrite,
}: {
  candidates: Candidate[];
  visible: Candidate[];
  selected: Set<string>;
  search: string;
  duplicates: Set<string>;
  selectedCount: number;
  selectedDuplicates: number;
  overwrite: boolean;
  busy: boolean;
  stale: boolean;
  onSearch: (value: string) => void;
  onToggle: (candidate: Candidate) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onInspect: (candidate: Candidate) => void;
  onOverwrite: (value: boolean) => void;
}) {
  const validCount = candidates.filter((candidate) => candidate.valid).length;
  return (
    <section className="space-y-2" aria-label="Detected skills">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-foreground">
          Detected skills{" "}
          <span className="font-mono text-[10px] text-muted-foreground">
            {validCount}/{candidates.length}
          </span>
        </h3>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[10px] text-muted-foreground">
            {selectedCount} selected
          </span>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={onSelectAll}
          >
            All
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy || selectedCount === 0}
            onClick={onClear}
          >
            None
          </Button>
        </div>
      </div>

      {candidates.length > 1 ? (
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder="Filter skills by name, path, or description"
            aria-label="Filter detected skills"
            autoComplete="off"
            spellCheck={false}
            className="h-9 pl-8 text-sm"
          />
        </div>
      ) : null}

      {stale ? (
        <p className="rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          The source changed. Preview again to refresh this list.
        </p>
      ) : null}

      <ul className="space-y-1.5">
        {visible.length === 0 ? (
          <li className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            No skills match “{search}”.
          </li>
        ) : (
          visible.map((candidate) => {
            const isSelected = selected.has(candidate.path);
            const isDuplicate = duplicates.has(candidate.name);
            return (
              <li key={candidate.path || "root"}>
                <div
                  className={cn(
                    "flex items-start gap-2.5 rounded-lg border px-2.5 py-2.5 transition-colors",
                    isSelected
                      ? "border-foreground/25 bg-muted/40"
                      : "border-border bg-transparent",
                    !candidate.valid && "opacity-70",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={busy || !candidate.valid}
                    onChange={() => onToggle(candidate)}
                    aria-label={`Select ${candidate.name}`}
                    className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => onInspect(candidate)}
                    disabled={busy || !candidate.valid}
                  >
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {candidate.name}
                      </span>
                      {isDuplicate ? (
                        <Badge variant="secondary" className="text-[9px]">
                          Installed
                        </Badge>
                      ) : null}
                      {!candidate.valid ? (
                        <Badge variant="outline" className="text-[9px]">
                          Invalid
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-0.5 block line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {candidate.description ||
                        candidate.error ||
                        "No description in SKILL.md."}
                    </span>
                    <span className="mt-1 block break-words font-mono text-[10px] leading-relaxed text-[var(--text-faint)] [overflow-wrap:anywhere]">
                      {candidate.path || "(repository root)"}
                      {candidate.fileCount > 0
                        ? ` · ${candidate.fileCount} file${candidate.fileCount === 1 ? "" : "s"}`
                        : ""}
                    </span>
                  </button>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    className="mt-0.5 shrink-0"
                    aria-label={`Preview ${candidate.name}`}
                    title="Preview skill"
                    disabled={busy || !candidate.valid}
                    onClick={() => onInspect(candidate)}
                  >
                    <Eye className="size-3.5" />
                  </Button>
                </div>
              </li>
            );
          })
        )}
      </ul>

      {selectedDuplicates > 0 ? (
        <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/20 px-2.5 py-2">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(event) => onOverwrite(event.target.checked)}
            disabled={busy}
            className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
          />
          <span className="min-w-0">
            <span className="block text-xs font-medium text-foreground">
              Replace {selectedDuplicates} existing skill
              {selectedDuplicates === 1 ? "" : "s"}
            </span>
            <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
              Off by default. Installed skills with the same name are skipped
              unless this is enabled.
            </span>
          </span>
        </label>
      ) : null}
    </section>
  );
}

function PreviewPanel({
  preview,
  path,
  candidates,
  selectedCount,
  installed,
  onBack,
}: {
  preview: PreviewDetail;
  path: string | null;
  candidates: Candidate[];
  selectedCount: number;
  installed: boolean;
  onBack: () => void;
}) {
  return (
    <section
      className="rounded-xl border border-border"
      aria-label={`Preview of ${preview.name}`}
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">
              {preview.name}
            </h3>
            <Badge variant="outline" className="text-[9px]">
              {sourceKindLabel(preview.sourceKind)}
            </Badge>
            {installed ? (
              <Badge variant="secondary" className="text-[9px]">
                Installed
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-[var(--text-faint)] [overflow-wrap:anywhere]">
            {path || preview.source}
          </p>
        </div>
        {candidates.length > 1 ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={onBack}
          >
            <ChevronLeft className="size-3" />
            Skills
          </Button>
        ) : null}
      </header>

      <div className="space-y-3 px-3 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {preview.description || "No description in SKILL.md."}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted/25 px-2.5 py-1.5 font-mono text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <ShieldCheck className="size-3" />
            {preview.fileCount} file{preview.fileCount === 1 ? "" : "s"}
          </span>
          <span className="break-all [overflow-wrap:anywhere]">
            ref {preview.resolvedRef.slice(0, 12)}
          </span>
          <span>{selectedCount} selected to install</span>
        </div>

        <div>
          <h4 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Files
          </h4>
          {preview.files.length === 0 ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              No packaged files.
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-1">
              {preview.files.map((file) => (
                <li
                  key={file}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  <FileText className="size-3 shrink-0" />
                  <span className="break-all [overflow-wrap:anywhere]">
                    {file}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h4 className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Instructions
          </h4>
          {preview.instructions.trim() ? (
            <ChatMarkdown
              content={preview.instructions}
              className="text-sm leading-relaxed"
            />
          ) : (
            <p className="text-[11px] text-muted-foreground">
              No instructions in this skill.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function SuccessState({
  result,
  candidates,
}: {
  result: InstallResult;
  candidates: Candidate[];
}) {
  const paths = new Map(candidates.map((candidate) => [candidate.name, candidate.path]));
  return (
    <div className="space-y-3" role="status" aria-live="polite">
      <div className="rounded-xl border border-border bg-muted/20 px-4 py-5 text-center">
        <CheckCircle2 className="mx-auto size-6 text-foreground" />
        <p className="mt-2 text-sm font-medium text-foreground">
          Installed {result.skills.length} skill
          {result.skills.length === 1 ? "" : "s"}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          They are available to new runs and visible in the installed list.
        </p>
      </div>

      <ul className="space-y-1.5">
        {result.skills.map((skill) => (
          <li
            key={skill.id}
            className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2"
          >
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-foreground">{skill.name}</p>
              <p className="break-words font-mono text-[10px] text-[var(--text-faint)] [overflow-wrap:anywhere]">
                {paths.get(skill.name) || skill.source}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {result.failures.length > 0 ? (
        <div className="rounded-xl border border-border bg-destructive/5 px-3 py-2.5">
          <p className="text-xs font-medium text-foreground">
            {result.failures.length} skill
            {result.failures.length === 1 ? "" : "s"} could not be installed
          </p>
          <ul className="mt-1.5 space-y-1">
            {result.failures.map((failure) => (
              <li
                key={`${failure.path}-${failure.message}`}
                className="text-[11px] leading-relaxed text-muted-foreground"
              >
                <span className="break-words font-mono text-foreground/80 [overflow-wrap:anywhere]">
                  {failure.path || "(repository root)"}
                </span>
                <span className="block break-words">{failure.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
