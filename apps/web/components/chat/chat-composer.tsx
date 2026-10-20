"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import {
  ArrowUp,
  BookOpen,
  ImagePlus,
  Loader2,
  Paperclip,
  Plus,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/model-picker";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSkillCount } from "@/hooks/use-skills";
import { cn } from "@/lib/utils";

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  model,
  onModelChange,
  disabled,
  submitting,
  streaming,
  error,
  placeholder = "Describe a coding task…",
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  model: string;
  onModelChange: (value: string) => void;
  modelPlaceholder?: string;
  disabled?: boolean;
  submitting?: boolean;
  streaming?: boolean;
  error?: string | null;
  placeholder?: string;
  /** Honest extra note prepended to the keyboard hint line. */
  hint?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { count: skillCount } = useSkillCount();

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const blocked = disabled || submitting;
  const hasText = value.trim().length > 0;

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    if (disabled || submitting || !hasText) return;
    onSubmit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSubmit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto w-full max-w-3xl shrink-0 px-3 pt-2 pb-safe-min sm:px-4"
    >
      <div
        className={cn(
          "rounded-xl border border-[var(--border)] bg-[var(--surface)] transition focus-within:border-[var(--text-faint)]",
          error && "border-[var(--text-faint)]",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          disabled={blocked}
          aria-label="Message"
          className="max-h-[200px] min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-2 text-[15px] leading-[1.6] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] disabled:opacity-60"
        />

        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          {/* Attach menu */}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-touch"
                  variant="ghost"
                  aria-label="Attach to message"
                  disabled={blocked}
                />
              }
            >
              <Plus className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className="w-56">
              <DropdownMenuLabel>Attach to message</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled className="cursor-default">
                <Paperclip className="size-3.5" />
                <span>Attach file</span>
                <span className="ml-auto text-2xs text-[var(--text-faint)]">soon</span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="cursor-default">
                <ImagePlus className="size-3.5" />
                <span>Attach image</span>
                <span className="ml-auto text-2xs text-[var(--text-faint)]">soon</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {skillCount > 0 ? (
            <Link
              href="/skills"
              aria-label={`${skillCount} skill${skillCount === 1 ? "" : "s"} installed`}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
            >
              <BookOpen className="size-3.5" />
              <span>Skills</span>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">
                {skillCount}
              </span>
            </Link>
          ) : null}

          {/* Model picker */}
          <ModelPicker
            value={model}
            onChange={onModelChange}
            disabled={blocked}
          />

          {/* Send / Stop buttons. While a run is streaming, Enter queues the
              draft; the stop button remains available beside send. */}
          <div className="ml-auto flex items-center gap-1.5">
            {streaming ? (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => onStop?.()}
                aria-label="Stop generation"
                className="size-8 rounded-full border border-[var(--border)] bg-transparent text-[var(--text)] hover:bg-[var(--surface-hover)]"
              >
                <Square className="size-3 fill-current" strokeWidth={0} />
              </Button>
            ) : null}
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={blocked || !hasText}
              aria-label={streaming ? "Queue message" : "Send message"}
              className="size-8 rounded-full border-0 bg-[var(--text)] text-[var(--bg)] hover:bg-[var(--text)]/90 disabled:opacity-30"
            >
              {submitting ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* Error message or keyboard hint */}
      {error ? (
        <p className="mt-2 px-1 text-xs text-[var(--text)]" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-2 hidden px-1 text-2xs text-[var(--text-faint)] sm:block">
          {hint ? <span className="mr-1">{hint} ·</span> : null}
          {streaming
            ? "Enter to queue · Shift+Enter for newline"
            : "Enter to send · Shift+Enter for newline"}
        </p>
      )}
    </form>
  );
}
