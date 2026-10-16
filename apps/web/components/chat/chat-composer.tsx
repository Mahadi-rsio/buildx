"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUp, ImagePlus, Loader2, Paperclip, Plus, Square } from "lucide-react";
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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const blocked = disabled || submitting || streaming;
  const hasText = value.trim().length > 0;

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    if (streaming && onStop) {
      onStop();
      return;
    }
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
          "rounded-2xl border border-border bg-card/70 shadow-sm transition focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20",
          error && "border-danger/40",
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
          className="max-h-[200px] min-h-12 w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
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
            <DropdownMenuContent align="start" sideOffset={6} className="w-56 rounded-xl bg-popover/95 backdrop-blur-md">
              <DropdownMenuLabel>Attach to message</DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-border/60" />
              <DropdownMenuItem disabled className="cursor-default">
                <Paperclip className="size-3.5" />
                <span>Attach file</span>
                <span className="ml-auto text-2xs text-muted-foreground/70">
                  soon
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem disabled className="cursor-default">
                <ImagePlus className="size-3.5" />
                <span>Attach image</span>
                <span className="ml-auto text-2xs text-muted-foreground/70">
                  soon
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ModelPicker
            value={model}
            onChange={onModelChange}
            disabled={blocked}
          />

          <div className="ml-auto flex items-center gap-1.5">
            {streaming ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                onClick={() => onStop?.()}
                aria-label="Stop generation"
              >
                <Square className="size-3.5" />
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon-touch"
                variant={hasText ? "default" : "ghost"}
                disabled={blocked || !hasText}
                aria-label="Send message"
                className={cn(!hasText && "text-muted-foreground")}
              >
                {submitting ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </Button>
            )}
          </div>
        </div>
      </div>
      {error ? (
        <p className="mt-2 px-1 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-2 hidden px-1 text-2xs text-muted-foreground sm:block">
          {hint ? <span className="mr-1">{hint} ·</span> : null}
          Enter to send · Shift+Enter for newline
        </p>
      )}
    </form>
  );
}