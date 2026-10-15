"use client";

import { GlyphMatrix } from "@/components/ui/glyph-matrix";
import { Button } from "@/components/ui/button";
import { TypingText } from "@/components/chat/typing-text";

const STARTERS = [
  {
    id: "greet",
    title: "Hello module",
    prompt:
      "Create src/greet.ts exporting a `greet(name: string)` function, add a README.md showing how to use it, and verify the file reads back correctly.",
  },
  {
    id: "cli",
    title: "Tiny CLI",
    prompt:
      "Scaffold a tiny Node ESM CLI in src/cli.ts that prints the current time, add a package.json with a `start` script, and verify the file contents.",
  },
  {
    id: "fix",
    title: "Fix & test",
    prompt:
      "Create src/math.ts with an `add(a, b)` function that intentionally returns a+b+1, then fix it to return a+b and write a short note in NOTES.md explaining the bug.",
  },
  {
    id: "readme",
    title: "Project README",
    prompt:
      "Create a concise README.md for a TypeScript utility package with install, usage, and scripts sections.",
  },
] as const;

export function ChatEmptyState({
  onSelect,
}: {
  onSelect: (prompt: string) => void;
}) {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.35] motion-reduce:hidden"
      >
        <GlyphMatrix
          className="size-full"
          color="oklch(0.55 0 0)"
          cellSize={16}
          mutationRate={0.025}
          interval={120}
          fadeBottom={0.75}
        />
      </div>

      <div className="relative z-10 mx-auto w-full max-w-2xl text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Buildx
        </p>
        <TypingText
          as="h1"
          text="What should we build?"
          duration={38}
          className="mt-3 min-h-[1.3em] text-3xl font-semibold tracking-tight text-foreground sm:text-4xl"
        />
        <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground">
          Describe a coding task. The agent plans, edits files, runs commands,
          and streams every step into a sandboxed workspace.
        </p>

        <div className="mt-8 grid gap-2 sm:grid-cols-2">
          {STARTERS.map((starter) => (
            <Button
              key={starter.id}
              type="button"
              variant="outline"
              className="h-auto items-start justify-start whitespace-normal rounded-xl px-4 py-3 text-left"
              onClick={() => onSelect(starter.prompt)}
            >
              <span className="block">
                <span className="block text-sm font-medium text-foreground">
                  {starter.title}
                </span>
                <span className="mt-1 block text-xs font-normal text-muted-foreground line-clamp-2">
                  {starter.prompt}
                </span>
              </span>
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}

export { STARTERS };
