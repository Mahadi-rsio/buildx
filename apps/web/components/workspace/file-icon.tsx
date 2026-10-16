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

  if (lower === "dockerfile") return { icon: TerminalSquare, tone: "text-info" };
  if (lower === "makefile") return { icon: FileCog, tone: "text-warning" };
  if (lower === "readme" || lower.endsWith("readme.md"))
    return { icon: FileText, tone: "text-info" };

  const map: Record<string, FileTone> = {
    ts: { icon: FileCode2, tone: "text-sky-400" },
    tsx: { icon: Braces, tone: "text-sky-400" },
    mjs: { icon: FileCode2, tone: "text-yellow-400" },
    cjs: { icon: FileCode2, tone: "text-yellow-400" },
    js: { icon: FileCode2, tone: "text-yellow-400" },
    jsx: { icon: Braces, tone: "text-sky-300" },
    json: { icon: FileJson, tone: "text-yellow-400" },
    md: { icon: FileText, tone: "text-info" },
    mdx: { icon: FileText, tone: "text-info" },
    css: { icon: FileType, tone: "text-indigo-300" },
    scss: { icon: FileType, tone: "text-pink-300" },
    less: { icon: FileType, tone: "text-indigo-300" },
    html: { icon: FileCode2, tone: "text-orange-400" },
    htm: { icon: FileCode2, tone: "text-orange-400" },
    py: { icon: FileCode2, tone: "text-emerald-300" },
    go: { icon: FileCode2, tone: "text-cyan-300" },
    rs: { icon: FileCode2, tone: "text-orange-300" },
    c: { icon: FileCode2, tone: "text-blue-300" },
    "c++": { icon: FileCode2, tone: "text-blue-300" },
    cpp: { icon: FileCode2, tone: "text-blue-300" },
    h: { icon: FileCode2, tone: "text-blue-300" },
    java: { icon: FileCode2, tone: "text-orange-300" },
    kt: { icon: FileCode2, tone: "text-orange-300" },
    rb: { icon: FileCode2, tone: "text-red-300" },
    php: { icon: FileCode2, tone: "text-violet-300" },
    sh: { icon: TerminalSquare, tone: "text-emerald-300" },
    bash: { icon: TerminalSquare, tone: "text-emerald-300" },
    zsh: { icon: TerminalSquare, tone: "text-emerald-300" },
    yml: { icon: FileCog, tone: "text-amber-300" },
    yaml: { icon: FileCog, tone: "text-amber-300" },
    toml: { icon: FileCog, tone: "text-amber-300" },
    ini: { icon: FileCog, tone: "text-amber-300" },
    conf: { icon: FileCog, tone: "text-amber-300" },
    env: { icon: FileCog, tone: "text-amber-300" },
    txt: { icon: FileText, tone: "text-muted-foreground" },
    log: { icon: FileText, tone: "text-muted-foreground" },
    png: { icon: FileImage, tone: "text-pink-300" },
    jpg: { icon: FileImage, tone: "text-pink-300" },
    jpeg: { icon: FileImage, tone: "text-pink-300" },
    gif: { icon: FileImage, tone: "text-pink-300" },
    svg: { icon: FileImage, tone: "text-pink-300" },
    webp: { icon: FileImage, tone: "text-pink-300" },
    ico: { icon: FileImage, tone: "text-pink-300" },
    mp3: { icon: FileAudio, tone: "text-purple-300" },
    wav: { icon: FileAudio, tone: "text-purple-300" },
    ogg: { icon: FileAudio, tone: "text-purple-300" },
    mp4: { icon: FileVideo, tone: "text-purple-300" },
    webm: { icon: FileVideo, tone: "text-purple-300" },
    mov: { icon: FileVideo, tone: "text-purple-300" },
    zip: { icon: FileArchive, tone: "text-amber-300" },
    gz: { icon: FileArchive, tone: "text-amber-300" },
    tar: { icon: FileArchive, tone: "text-amber-300" },
    sql: { icon: Database, tone: "text-blue-300" },
    db: { icon: Database, tone: "text-blue-300" },
    sqlite: { icon: Database, tone: "text-blue-300" },
    prisma: { icon: Database, tone: "text-teal-300" },
    lock: { icon: FileCog, tone: "text-muted-foreground" },
    jsonc: { icon: FileJson, tone: "text-yellow-400" },
    csv: { icon: FileText, tone: "text-emerald-300" },
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