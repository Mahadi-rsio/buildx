"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, BookOpen, Loader2, Plus } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InstallSkillDialog } from "@/components/skills/install-skill-dialog";
import { SkillCard } from "@/components/skills/skill-card";
import { SkillDetailSheet } from "@/components/skills/skill-detail-sheet";
import { useSkills, type SkillView } from "@/hooks/use-skills";

function messageFor(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export function SkillsPage() {
  const { skills, error, loading, install, uninstall, setEnabled } = useSkills();
  const [installOpen, setInstallOpen] = useState(false);
  const [detail, setDetail] = useState<SkillView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const shownError = actionError ?? error;
  const isMigrated = !shownError?.toLowerCase().includes("migration");
  const groups = useMemo(() => {
    const bySource = new Map<string, SkillView[]>();
    for (const skill of skills ?? []) {
      const group = bySource.get(skill.source) ?? [];
      group.push(skill);
      bySource.set(skill.source, group);
    }
    return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [skills]);
  const activeCount = (skills ?? []).filter((skill) => skill.enabled).length;

  async function handleToggle(skill: SkillView) {
    setBusyId(skill.id);
    setActionError(null);
    try {
      await setEnabled(skill.id, !skill.enabled);
    } catch (caught) {
      setActionError(messageFor(caught));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(skill: SkillView) {
    setBusyId(skill.id);
    setActionError(null);
    try {
      await uninstall(skill.id);
    } catch (caught) {
      setActionError(messageFor(caught));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-5 overflow-y-auto px-4 py-6 sm:px-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-lg font-medium text-foreground">
            Skills
          </h1>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Available to every new run. Only name/description enter the prompt;
            full instructions load on demand. Scripts are never executed.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => setInstallOpen(true)}
          disabled={!isMigrated}
        >
          <Plus className="size-3.5" />
          Install skill
        </Button>
      </header>

      {shownError ? (
        <Alert variant={isMigrated ? "default" : "destructive"}>
          <AlertTriangle />
          <AlertTitle>
            {isMigrated ? "Something went wrong" : "Database migration required"}
          </AlertTitle>
          <AlertDescription>{shownError}</AlertDescription>
        </Alert>
      ) : null}

      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Installed
          </h2>
          {skills?.length ? (
            <span className="text-2xs text-[var(--text-faint)]">
              {activeCount} active · {skills.length} total
            </span>
          ) : null}
        </div>
        {loading && skills === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading skills…
          </div>
        ) : (skills ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <BookOpen className="mx-auto size-5 text-muted-foreground" />
            <p className="mt-2 text-sm text-foreground">No skills installed</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Install a skill from GitHub, a SKILL.md URL, or a zip/tarball.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {groups.map(([source, group]) => {
              const groupActive = group.filter((skill) => skill.enabled).length;
              return (
                <div key={source} className="space-y-2">
                  <div className="flex min-w-0 items-center gap-2 px-1">
                    <span
                      className="truncate font-mono text-[11px] text-[var(--text-muted)]"
                      title={source}
                    >
                      {source}
                    </span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {group[0]?.sourceKind === "github"
                        ? "GitHub"
                        : group[0]?.sourceKind === "url"
                          ? "URL"
                          : "Archive"}
                    </Badge>
                    <span className="ml-auto shrink-0 text-2xs text-[var(--text-faint)]">
                      {groupActive}/{group.length} active
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {group.map((skill) => (
                      <SkillCard
                        key={skill.id}
                        skill={skill}
                        busy={busyId === skill.id}
                        onToggle={() => void handleToggle(skill)}
                        onView={() => setDetail(skill)}
                        onDelete={() => handleDelete(skill)}
                      />
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <InstallSkillDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstall={install}
        installed={skills ?? []}
      />

      <SkillDetailSheet
        skill={detail}
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null);
        }}
      />
    </div>
  );
}
