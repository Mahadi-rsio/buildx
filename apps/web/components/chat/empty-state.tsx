"use client";

import { GlyphMatrix } from "@/components/ui/glyph-matrix";
import { TypingText } from "@/components/chat/typing-text";
import { ThinkingTrace } from "@/components/chat/thinking-trace";
import { useConfig } from "@/hooks/use-config";
import { Sparkles, Terminal, ShieldCheck, Zap } from "lucide-react";

/** `deepseek/deepseek-v4-flash-0731` → `DeepSeek V4 Flash 0731`. */
function prettifyModel(id: string | undefined): string {
  if (!id) return "Multi-Model Support";
  const leaf = id.includes("/") ? id.split("/").pop() ?? id : id;
  return leaf
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

export function ChatEmptyState({
  onSelect: _onSelect,
}: {
  onSelect?: (prompt: string) => void;
}) {
  const { config } = useConfig();
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-12 text-center">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.25] motion-reduce:hidden"
      >
        <GlyphMatrix
          className="size-full"
          color="oklch(0.55 0 0)"
          cellSize={16}
          mutationRate={0.02}
          interval={140}
          fadeBottom={0.8}
        />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-xl">
        <div className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-muted/40 px-3 py-1 text-xs text-muted-foreground shadow-xs backdrop-blur-md">
          <ThinkingTrace className="text-muted-foreground/80" />
          <span className="font-mono text-[11px] font-medium tracking-wide uppercase">
            Autonomous Coding Agent
          </span>
        </div>

        <TypingText
          as="h1"
          text="What should we build?"
          duration={36}
          className="mt-4 min-h-[1.3em] text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
        />

        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
          Describe any coding task or system. The agent plans architecture,
          edits files, executes tests, and streams every step in real-time.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2 text-[11px] text-muted-foreground">
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1 backdrop-blur-xs">
            <Terminal className="size-3 text-primary/70" />
            <span>Full Shell Sandbox</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1 backdrop-blur-xs">
            <Sparkles className="size-3 text-primary/70" />
            <span>{prettifyModel(config?.model)}</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1 backdrop-blur-xs">
            <ShieldCheck className="size-3 text-primary/70" />
            <span>Isolated Environment</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/40 px-2.5 py-1 backdrop-blur-xs">
            <Zap className="size-3 text-primary/70" />
            <span>Live Streaming Loop</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export const STARTERS = [];
