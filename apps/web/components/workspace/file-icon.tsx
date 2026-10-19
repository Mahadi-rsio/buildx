"use client";

import {
  Braces,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileCog,
  FileImage,
  FileJson,
  FileText,
  FileType,
  FileVideo,
  TerminalSquare,
  Database,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FileTone {
  icon: LucideIcon;
  /** Tailwind text color class; stays in the app palette (no hardcoded hex). */
  tone: string;
}

const DEFAULT_TONE: FileTone = { icon: File, tone: "text-muted-foreground" };

/**
 * Map a file path to an icon + semantic color. Plain extension lookups first;
 * composite names (Dockerfile, Makefile) and dotfiles fall back to a readable
 * default so unknown files still look intentional.
 */
export function fileTone(path: string): FileTone {
  const name = path.split("/").pop() ?? path;
  const lower = name.toLowerCase();
  const ext = lower.split(".").pop() ?? "";

  if (lower === "dockerfile") return { icon: TerminalSquare, tone: "text-[var(--text-muted)]" };
  if (lower === "makefile") return { icon: FileCog, tone: "text-[var(--text-muted)]" };
  if (lower === "readme" || lower.endsWith("readme.md"))
    return { icon: FileText, tone: "text-[var(--text-muted)]" };

  const map: Record<string, FileTone> = {
    ts: { icon: FileCode2, tone: "text-[var(--text-muted)]" },
    tsx: { icon: Braces, tone: "text-[var(--text-muted)]" },
    mjs: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    cjs: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    js: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    jsx: { icon: Braces, tone: "text-[var(--text-muted)]" },
    json: { icon: FileJson, tone: "text-[var(--text-faint)]" },
    md: { icon: FileText, tone: "text-[var(--text-muted)]" },
    mdx: { icon: FileText, tone: "text-[var(--text-muted)]" },
    css: { icon: FileType, tone: "text-[var(--text-faint)]" },
    scss: { icon: FileType, tone: "text-[var(--text-faint)]" },
    less: { icon: FileType, tone: "text-[var(--text-faint)]" },
    html: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    htm: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    py: { icon: FileCode2, tone: "text-[var(--text-muted)]" },
    go: { icon: FileCode2, tone: "text-[var(--text-muted)]" },
    rs: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    c: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    "c++": { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    cpp: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    h: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    java: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    kt: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    rb: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    php: { icon: FileCode2, tone: "text-[var(--text-faint)]" },
    sh: { icon: TerminalSquare, tone: "text-[var(--text-muted)]" },
    bash: { icon: TerminalSquare, tone: "text-[var(--text-muted)]" },
    zsh: { icon: TerminalSquare, tone: "text-[var(--text-muted)]" },
    yml: { icon: FileCog, tone: "text-[var(--text-faint)]" },
    yaml: { icon: FileCog, tone: "text-[var(--text-faint)]" },
    toml: { icon: FileCog, tone: "text-[var(--text-faint)]" },
    ini: { icon: FileCog, tone: "text-[var(--text-faint)]" },
    conf: { icon: FileCog, tone: "text-[var(--text-faint)]" },
    env: { icon: FileCog, tone: "text-[var(--text-faint)]" },
    txt: { icon: FileText, tone: "text-muted-foreground" },
    log: { icon: FileText, tone: "text-muted-foreground" },
    png: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    jpg: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    jpeg: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    gif: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    svg: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    webp: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    ico: { icon: FileImage, tone: "text-[var(--text-faint)]" },
    mp3: { icon: FileAudio, tone: "text-[var(--text-faint)]" },
    wav: { icon: FileAudio, tone: "text-[var(--text-faint)]" },
    ogg: { icon: FileAudio, tone: "text-[var(--text-faint)]" },
    mp4: { icon: FileVideo, tone: "text-[var(--text-faint)]" },
    webm: { icon: FileVideo, tone: "text-[var(--text-faint)]" },
    mov: { icon: FileVideo, tone: "text-[var(--text-faint)]" },
    zip: { icon: FileArchive, tone: "text-[var(--text-faint)]" },
    gz: { icon: FileArchive, tone: "text-[var(--text-faint)]" },
    tar: { icon: FileArchive, tone: "text-[var(--text-faint)]" },
    sql: { icon: Database, tone: "text-[var(--text-muted)]" },
    db: { icon: Database, tone: "text-[var(--text-muted)]" },
    sqlite: { icon: Database, tone: "text-[var(--text-muted)]" },
    prisma: { icon: Database, tone: "text-[var(--text-faint)]" },
    lock: { icon: FileCog, tone: "text-muted-foreground" },
    jsonc: { icon: FileJson, tone: "text-[var(--text-faint)]" },
    csv: { icon: FileText, tone: "text-[var(--text-muted)]" },
  };

  if (ext && map[ext]) return map[ext];
  if (lower.startsWith(".") && ext !== lower) return DEFAULT_TONE;
  return map[ext] ?? DEFAULT_TONE;
}

export function FileIcon({
  path,
  className,
}: {
  path: string;
  className?: string;
}) {
  const { icon: Icon, tone } = fileTone(path);
  return <Icon className={cn("shrink-0", tone, className)} aria-hidden />;
}