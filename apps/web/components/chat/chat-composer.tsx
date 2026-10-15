"use client";

import {
  useEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Loader2, Paperclip, Square, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  model,
  onModelChange,
  modelPlaceholder,
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

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    if (streaming && onStop) {
      onStop();
      return;
    }
    if (disabled || submitting || value.trim().length === 0) return;
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
      className="mx-auto w-full max-w-3xl px-3 pb-3 pt-2 sm:px-4 sm:pb-4"
    >
      <div
        className={cn(
          "rounded-2xl border border-border bg-card/70 shadow-sm transition focus-within:border-ring/50 focus-within:ring-2 focus-within:ring-ring/20",
          error && "border-red-500/40",
        )}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          disabled={disabled || submitting || streaming}
          aria-label="Message"
          className="max-h-[200px] min-h-[48px] w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  disabled
                  aria-label="Attachments unavailable"
                />
              }
            >
              <Paperclip className="size-4" />
            </TooltipTrigger>
            <TooltipContent>File attachments are not available yet</TooltipContent>
          </Tooltip>

          <Input
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            placeholder={modelPlaceholder ?? "model"}
            disabled={disabled || submitting || streaming}
            aria-label="Model override"
            className="h-7 max-w-[11rem] border-transparent bg-muted/40 font-mono text-[11px] sm:max-w-[14rem]"
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
                size="icon-sm"
                disabled={
                  disabled || submitting || value.trim().length === 0
                }
                aria-label="Send message"
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
        <p className="mt-2 px-1 text-xs text-red-400" role="alert">
          {error}
        </p>
      ) : (
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          {hint ? <span className="mr-1">{hint} ·</span> : null}
          Enter to send · Shift+Enter for newline
        </p>
      )}
    </form>
  );
}
