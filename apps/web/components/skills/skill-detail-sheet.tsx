"use client";

import { useEffect, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { SkillView } from "@/hooks/use-skills";

interface SkillDetail {
  instructions: string;
  files: string[];
}

function sourceKindLabel(kind: SkillView["sourceKind"]): string {
  if (kind === "github") return "GitHub";
  if (kind === "url") return "URL";
  return "Archive";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function shorten(value: string, max = 32): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function detailError(
  response: Response,
  data: { error?: string; message?: string },
): string {
  if (data.error === "schema_not_migrated") {
    return "Database migration required. Run the database migrations.";
  }
  return data.message ?? data.error ?? `Request failed (${response.status})`;
}

export function SkillDetailSheet({
  skill,
  open,
  onOpenChange,
}: {
  skill: SkillView | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-md">
        {open && skill ? <SkillDetailBody key={skill.id} skill={skill} /> : null}
      </SheetContent>
    </Sheet>
  );
}

function SkillDetailBody({ skill }: { skill: SkillView }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const response = await fetch(`/api/skills/${skill.id}`, {
          cache: "no-store",
        });
        const data = (await response.json().catch(() => ({}))) as {
          skill?: SkillView;
          instructions?: string;
          files?: string[];
          error?: string;
          message?: string;
        };
        if (!alive) return;
        if (!response.ok) throw new Error(detailError(response, data));
        setDetail({
          instructions: data.instructions ?? "",
          files: Array.isArray(data.files) ? data.files : [],
        });
        setError(null);
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => {
      alive = false;
    };
  }, [skill.id]);

  return (
    <>
      <SheetHeader className="border-b border-border/70 pr-12">
        <div className="flex flex-wrap items-center gap-1.5">
          <SheetTitle className="truncate">{skill.name}</SheetTitle>
          <Badge variant="outline" className="text-[10px]">
            {sourceKindLabel(skill.sourceKind)}
          </Badge>
          <Badge variant="secondary" className="text-[10px]">
            {skill.scope}
          </Badge>
        </div>
        <SheetDescription>{skill.description}</SheetDescription>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">Source</dt>
          <dd className="min-w-0">
            {isHttpUrl(skill.source) ? (
              <a
                href={skill.source}
                target="_blank"
                rel="noreferrer"
                className="block truncate font-mono text-[11px] text-foreground underline decoration-[var(--text-faint)] underline-offset-2 hover:decoration-[var(--text)]"
              >
                {skill.source}
              </a>
            ) : (
              <span className="block truncate font-mono text-[11px] text-foreground">
                {skill.source}
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">Ref</dt>
          <dd
            className="truncate font-mono text-[11px] text-foreground"
            title={skill.resolvedRef}
          >
            {shorten(skill.resolvedRef)}
          </dd>
          <dt className="text-muted-foreground">Digest</dt>
          <dd
            className="truncate font-mono text-[11px] text-foreground"
            title={skill.digest}
          >
            {skill.digest.slice(0, 16)}
          </dd>
          <dt className="text-muted-foreground">Files</dt>
          <dd className="font-mono text-[11px] text-foreground">
            {skill.fileCount} · {formatBytes(skill.totalBytes)}
          </dd>
          <dt className="text-muted-foreground">Installed</dt>
          <dd className="font-mono text-[11px] text-foreground">
            {new Date(skill.installedAt).toLocaleString()}
          </dd>
        </dl>

        {error ? (
          <p className="rounded-lg border border-border px-2.5 py-2 text-xs text-[var(--text)]">
            {error}
          </p>
        ) : detail === null ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
            Loading skill…
          </div>
        ) : (
          <>
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Files
              </h3>
              {detail.files.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No packaged files.
                </p>
              ) : (
                <ul className="space-y-1">
                  {detail.files.map((file) => (
                    <li
                      key={file}
                      className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5"
                    >
                      <FileText className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate font-mono text-[11px] text-foreground">
                        {file}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-1.5">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Instructions
              </h3>
              {detail.instructions.trim().length > 0 ? (
                <ChatMarkdown content={detail.instructions} className="text-sm" />
              ) : (
                <p className="text-xs text-muted-foreground">
                  No instructions in this skill.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </>
  );
}
