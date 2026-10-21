"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import {
  ArrowUp,
  BookOpen,
  Check,
  ImagePlus,
  Loader2,
  Paperclip,
  Plus,
  Square,
  X,
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
import type { SkillView } from "@/hooks/use-skills";
import { cn } from "@/lib/utils";

/** Mirrors the API/schema cap so the composer cannot submit an invalid turn. */
const MAX_SELECTED_SKILLS = 20;

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  model,
  onModelChange,
  skills = [],
  skillsLoading = false,
  selectedSkills,
  onSelectedSkillsChange,
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
  skills?: SkillView[];
  skillsLoading?: boolean;
  selectedSkills: string[];
  onSelectedSkillsChange: (names: string[]) => void;
  disabled?: boolean;
  submitting?: boolean;
  streaming?: boolean;
  error?: string | null;
  placeholder?: string;
  /** Honest extra note prepended to the keyboard hint line. */
  hint?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);

  const enabledSkills = useMemo(
    () => skills.filter((skill) => skill.enabled),
    [skills],
  );
  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return enabledSkills;
    return enabledSkills.filter((skill) =>
      `${skill.name} ${skill.description} ${skill.source}`
        .toLowerCase()
        .includes(needle),
    );
  }, [enabledSkills, query]);
  const activeIndex =
    filteredSkills.length === 0
      ? -1
      : Math.min(highlight, filteredSkills.length - 1);

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

  function handleValueChange(next: string) {
    onChange(next);
    const slash = /^\/([^\s]*)$/.exec(next);
    if (slash) {
      setPaletteOpen(true);
      setQuery(slash[1]);
      setHighlight(0);
    } else if (paletteOpen) {
      setPaletteOpen(false);
      setQuery("");
    }
  }

  function toggleSkill(name: string) {
    const attached = selectedSkills.includes(name);
    if (!attached && selectedSkills.length >= MAX_SELECTED_SKILLS) return;
    const next = attached
      ? selectedSkills.filter((skill) => skill !== name)
      : [...selectedSkills, name];
    onSelectedSkillsChange(next);
    if (/^\/[^\s]*$/.test(value)) onChange("");
    setPaletteOpen(false);
    setQuery("");
    textareaRef.current?.focus();
  }

  function removeSkill(name: string) {
    onSelectedSkillsChange(
      selectedSkills.filter((skill) => skill !== name),
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (paletteOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (filteredSkills.length > 0) {
          setHighlight((current) => (current + 1) % filteredSkills.length);
        }
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (filteredSkills.length > 0) {
          setHighlight(
            (current) =>
              (current - 1 + filteredSkills.length) % filteredSkills.length,
          );
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setPaletteOpen(false);
        setQuery("");
        return;
      }
      if (
        event.key === "Enter" &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault();
        if (activeIndex >= 0) {
          toggleSkill(filteredSkills[activeIndex].name);
        }
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSubmit();
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="relative mx-auto w-full max-w-3xl shrink-0 px-3 pt-2 pb-safe-min sm:px-4"
    >
      {paletteOpen ? (
        <div className="absolute bottom-full left-3 right-3 z-30 mb-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-lg sm:left-4 sm:right-4">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <BookOpen className="size-3.5 text-[var(--text-muted)]" />
            <span className="text-xs font-medium text-[var(--text)]">
              Attach a skill
            </span>
            {selectedSkills.length > 0 ? (
              <span className="ml-auto text-2xs text-[var(--text-faint)]">
                {selectedSkills.length} selected
              </span>
            ) : null}
          </div>
          {skillsLoading ? (
            <div className="flex items-center gap-2 px-3 py-4 text-xs text-[var(--text-muted)]">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
              Loading skills…
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="px-3 py-4 text-xs text-[var(--text-muted)]">
              {enabledSkills.length === 0 ? (
                <>
                  No enabled skills.{" "}
                  <Link
                    href="/skills"
                    className="text-[var(--text)] underline underline-offset-2"
                  >
                    Install one
                  </Link>
                </>
              ) : (
                <>No skills match “{query}”.</>
              )}
            </div>
          ) : (
            <ul className="max-h-72 overflow-y-auto p-1">
              {filteredSkills.map((skill, index) => {
                const selected = selectedSkills.includes(skill.name);
                const atLimit =
                  !selected && selectedSkills.length >= MAX_SELECTED_SKILLS;
                return (
                  <li key={skill.id}>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => toggleSkill(skill.name)}
                      onMouseEnter={() => setHighlight(index)}
                      disabled={atLimit}
                      title={atLimit ? "Remove a skill to attach another" : undefined}
                      className={cn(
                        "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition",
                        index === activeIndex && "bg-[var(--surface-hover)]",
                        atLimit && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <BookOpen className="mt-0.5 size-3.5 shrink-0 text-[var(--text-faint)]" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-[var(--text)]">
                            {skill.name}
                          </span>
                          {skill.source ? (
                            <span className="truncate font-mono text-2xs text-[var(--text-faint)]">
                              {skill.source}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 line-clamp-1 text-xs text-[var(--text-muted)]">
                          {skill.description}
                        </span>
                      </span>
                      {selected ? (
                        <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--text)]" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="border-t border-[var(--border)] px-3 py-1.5 text-2xs text-[var(--text-faint)]">
            {selectedSkills.length >= MAX_SELECTED_SKILLS ? (
              <>Maximum {MAX_SELECTED_SKILLS} skills attached.</>
            ) : (
              <>
                Type <span className="font-mono">/</span> to filter · Enter to
                attach · Esc to close
              </>
            )}
          </div>
        </div>
      ) : null}

      <div
        className={cn(
          "rounded-xl border border-[var(--border)] bg-[var(--surface)] transition focus-within:border-[var(--text-faint)]",
          error && "border-[var(--text-faint)]",
        )}
      >
        {selectedSkills.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {selectedSkills.map((name) => (
              <span
                key={name}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--bg)]/40 pl-2 pr-1 text-[11px] text-[var(--text-muted)]"
              >
                <BookOpen className="size-3 text-[var(--text-faint)]" />
                <span className="max-w-40 truncate">{name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${name} skill`}
                  onClick={() => removeSkill(name)}
                  disabled={blocked}
                  className="flex size-4 items-center justify-center rounded-full text-[var(--text-faint)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => handleValueChange(e.target.value)}
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

          {skills.length > 0 || selectedSkills.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setPaletteOpen((open) => !open);
                setQuery("");
                setHighlight(0);
              }}
              disabled={blocked}
              aria-expanded={paletteOpen}
              aria-label={`Attach a skill (${enabledSkills.length} enabled)`}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)] disabled:opacity-50"
            >
              <BookOpen className="size-3.5" />
              <span>Skills</span>
              <span className="font-mono text-[10px] text-[var(--text-faint)]">
                {enabledSkills.length}
              </span>
            </button>
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
