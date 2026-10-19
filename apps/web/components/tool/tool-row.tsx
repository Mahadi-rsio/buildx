"use client";

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronRight, Loader2, X } from "lucide-react";
import { pretty, type StreamItem } from "@/components/run-events";
import { ansiToHtml, hasAnsi } from "@/lib/ansi";
import { computeLineDiff } from "@/lib/diff";
import { cn } from "@/lib/utils";

type ToolItem = Extract<StreamItem, { kind: "tool" }>;
type ToolStatus = "running" | "done" | "error";

function toolStatus(item: ToolItem, cancelled: boolean): ToolStatus {
  if (item.isError) return "error";
  if (item.pending) return cancelled ? "error" : "running";
  return "done";
}

function verbFor(
  status: ToolStatus,
  present: string,
  past: string,
): string {
  return status === "running" ? present : past;
}

function parseInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }
  if (input !== null && typeof input === "object") {
    return input as Record<string, unknown>;
  }
  return {};
}

function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function splitPath(path: string): { dir: string; name: string } {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { dir: "", name: path };
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

function bashOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.output === "string") return record.output;
  if (typeof record.text === "string") return record.text;
  if (typeof record.stdout === "string") {
    const stderr = typeof record.stderr === "string" ? record.stderr : "";
    return [record.stdout, stderr].filter(Boolean).join("\n");
  }
  return "";
}

function lineCount(value: string): number {
  if (value.length === 0) return 0;
  return value.replace(/\n$/, "").split("\n").length;
}

function useDisclosure(autoOpen: boolean) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? autoOpen;
  return {
    open,
    toggle: () => setOverride(!open),
  };
}

function StatusIcon({ status }: { status: ToolStatus }) {
  const iconClass = "size-3.5 shrink-0 stroke-[1.5]";
  if (status === "running") {
    return (
      <Loader2
        aria-hidden
        className={cn(
          iconClass,
          "animate-spin text-[var(--text-muted)] motion-reduce:animate-none",
        )}
      />
    );
  }
  if (status === "error") {
    return <X aria-hidden className={cn(iconClass, "text-[var(--text)]")} />;
  }
  return (
    <Check aria-hidden className={cn(iconClass, "text-[var(--text-faint)]")} />
  );
}

export function ToolRow({
  status,
  verb,
  target,
  meta,
  expandable = false,
  open = false,
  onToggle,
  children,
  contentId,
}: {
  status: ToolStatus;
  verb?: ReactNode;
  target: ReactNode;
  meta?: ReactNode;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
  contentId?: string;
}) {
  const rowClass = cn(
    "flex h-9 md:h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left",
    expandable && "hover:bg-[var(--surface-hover)]",
  );

  const content = (
    <>
      <StatusIcon status={status} />
      {verb ? (
        <span className="shrink-0 text-[13px] text-[var(--text-muted)]">
          {verb}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-[var(--text)]">
        {target}
      </span>
      {meta ? (
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-faint)]">
          {meta}
        </span>
      ) : null}
      {expandable ? (
        <ChevronRight
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 stroke-[1.5] text-[var(--text-faint)] transition-transform",
            open && "rotate-90",
          )}
        />
      ) : null}
    </>
  );

  return (
    <div>
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={contentId}
          className={rowClass}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
      {expandable && open && children ? (
        <div id={contentId} className="mb-2 ml-[22px] mt-1">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function OutputBlock({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onScroll = () => {
      atBottom.current =
        element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
    };
    onScroll();
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = new MutationObserver(() => {
      if (atBottom.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, []);

  return (
    <pre
      ref={ref}
      className={cn(
        "max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface)] p-3 font-mono text-xs leading-5 text-[var(--text-muted)]",
        className,
      )}
    >
      {children}
    </pre>
  );
}

function AnsiOutput({ text }: { text: string }) {
  if (!hasAnsi(text)) return <span>{text}</span>;
  return (
    <span
      dangerouslySetInnerHTML={{ __html: ansiToHtml(text) }}
    />
  );
}

function FileTarget({ path }: { path: string }) {
  const { dir, name } = splitPath(path);
  return (
    <span className="flex min-w-0 items-baseline" title={path}>
      {/* Mobile: basename only, never ellipsized. */}
      <span className="shrink-0 md:hidden">{name}</span>
      {/* Desktop: truncate only the directory; the basename stays intact. */}
      <span className="hidden min-w-0 items-baseline md:flex">
        {dir ? (
          <span className="min-w-0 truncate text-[var(--text-faint)]">
            {dir}
          </span>
        ) : null}
        <span className="shrink-0 text-[var(--text)]">{name}</span>
      </span>
    </span>
  );
}

function BashTarget({ command }: { command: string }) {
  return (
    <span className="flex min-w-0 items-baseline" title={command}>
      <span className="mr-1 shrink-0 text-[var(--text-faint)]">$</span>
      <span className="min-w-0 truncate">{command}</span>
    </span>
  );
}

function FullPath({ path }: { path: string }) {
  return (
    <span className="mb-1 block truncate font-mono text-[11px] text-[var(--text-faint)]">
      {path}
    </span>
  );
}

function FlatCode({ code }: { code: string }) {
  return (
    <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface)] p-3 font-mono text-xs leading-5 text-[var(--text-muted)]">
      {code}
    </pre>
  );
}

function FlatDiff({ oldText, newText }: { oldText: string; newText: string }) {
  const rows = computeLineDiff(oldText, newText);
  return (
    <div className="max-h-60 overflow-auto rounded-md bg-[var(--surface)] py-2 font-mono text-xs leading-5">
      {rows.map((row, index) => (
        <div
          key={`${row.type}-${index}`}
          className={cn(
            "relative whitespace-pre-wrap break-words px-3",
            row.type === "add" &&
              "bg-[var(--surface-hover)] pl-3 text-[var(--text)] before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-[var(--text)]",
            row.type === "del" &&
              "text-[var(--text-faint)] line-through",
            row.type === "ctx" && "text-[var(--text-muted)]",
          )}
        >
          <span className="mr-2 inline-block w-3 select-none text-[var(--text-faint)]">
            {row.type === "add" ? "+" : row.type === "del" ? "−" : " "}
          </span>
          {row.text || " "}
        </div>
      ))}
    </div>
  );
}

interface RendererProps {
  item: ToolItem;
  status: ToolStatus;
  input: Record<string, unknown>;
}

function ReadTool({ item, status, input }: RendererProps) {
  const path =
    stringField(input, "path") ??
    stringField(input, "file_path") ??
    pretty(item.input);
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Reading", "Read")}
      target={<FileTarget path={path} />}
    />
  );
}

function WriteTool({ item, status, input }: RendererProps) {
  const path = stringField(input, "path") ?? "";
  const content = stringField(input, "content") ?? "";
  const added = lineCount(content);
  const { open, toggle } = useDisclosure(false);
  const contentId = `tool-${item.toolCallId}`;
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Writing", "Wrote")}
      target={<FileTarget path={path || pretty(item.input)} />}
      meta={added > 0 ? `+${added}` : undefined}
      expandable
      open={open}
      onToggle={toggle}
      contentId={contentId}
    >
      <FullPath path={path} />
      {content.length > 0 ? (
        <FlatCode code={content} />
      ) : (
        <OutputBlock>{pretty(item.input)}</OutputBlock>
      )}
    </ToolRow>
  );
}

function EditTool({ item, status, input }: RendererProps) {
  const path = stringField(input, "path") ?? "";
  const oldText = stringField(input, "old_str") ?? "";
  const newText = stringField(input, "new_str") ?? "";
  const rows = computeLineDiff(oldText, newText);
  const added = rows.filter((row) => row.type === "add").length;
  const removed = rows.filter((row) => row.type === "del").length;
  const { open, toggle } = useDisclosure(false);
  const contentId = `tool-${item.toolCallId}`;
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Editing", "Edited")}
      target={<FileTarget path={path || pretty(item.input)} />}
      meta={
        added > 0 || removed > 0 ? (
          <>
            {added > 0 ? `+${added}` : null}
            {added > 0 && removed > 0 ? " " : null}
            {removed > 0 ? `−${removed}` : null}
          </>
        ) : undefined
      }
      expandable
      open={open}
      onToggle={toggle}
      contentId={contentId}
    >
      <FullPath path={path} />
      {oldText.length > 0 || newText.length > 0 ? (
        <FlatDiff oldText={oldText} newText={newText} />
      ) : (
        <OutputBlock>{pretty(item.input)}</OutputBlock>
      )}
    </ToolRow>
  );
}

function BashTool({ item, status, input }: RendererProps) {
  const command = stringField(input, "command") ?? pretty(item.input);
  const raw = bashOutput(item.output);
  const text = raw.length > 0 ? raw : item.isError ? pretty(item.output) : "";
  const { open, toggle } = useDisclosure(
    status === "running" || status === "error",
  );
  const contentId = `tool-${item.toolCallId}`;
  return (
    <ToolRow
      status={status}
      target={<BashTarget command={command} />}
      expandable
      open={open}
      onToggle={toggle}
      contentId={contentId}
    >
      <OutputBlock>
        {text.length > 0 ? (
          <AnsiOutput text={text} />
        ) : (
          <span className="text-[var(--text-faint)]">
            {status === "running" ? "Waiting for output…" : "(no output)"}
          </span>
        )}
      </OutputBlock>
    </ToolRow>
  );
}

function ListTool({ status, input }: RendererProps) {
  const path = stringField(input, "path") || ".";
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Listing", "Listed")}
      target={<FileTarget path={path} />}
    />
  );
}

function resultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return pretty(output);
  const record = output as Record<string, unknown>;
  if (Array.isArray(record.files)) {
    return record.files.map((file) => String(file)).join("\n");
  }
  if (typeof record.matches === "string") return record.matches;
  if (Array.isArray(record.results)) {
    return record.results
      .map((result) => {
        const entry = result as Record<string, unknown>;
        return `${String(entry.path)}:${String(entry.startLine)}-${String(entry.endLine)}\n${String(entry.snippet ?? "")}`;
      })
      .join("\n\n");
  }
  return pretty(output);
}

function SearchTool({ item, status, input }: RendererProps) {
  const target =
    stringField(input, "pattern") ??
    stringField(input, "query") ??
    pretty(item.input);
  const text = resultText(item.output);
  const { open, toggle } = useDisclosure(false);
  const contentId = `tool-${item.toolCallId}`;
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Searching", "Searched")}
      target={<span className="min-w-0 truncate">{target}</span>}
      expandable={text.length > 0}
      open={open}
      onToggle={toggle}
      contentId={contentId}
    >
      <OutputBlock>{text || "(no matches)"}</OutputBlock>
    </ToolRow>
  );
}

function GlobTool({ item, status, input }: RendererProps) {
  const pattern = input.pattern;
  const target = Array.isArray(pattern)
    ? pattern.map(String).join(", ")
    : stringField(input, "pattern") ?? pretty(item.input);
  const text = resultText(item.output);
  const { open, toggle } = useDisclosure(false);
  const contentId = `tool-${item.toolCallId}`;
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Finding", "Found")}
      target={<span className="min-w-0 truncate">{target}</span>}
      meta={
        item.output &&
        typeof item.output === "object" &&
        "count" in item.output
          ? String((item.output as Record<string, unknown>).count)
          : undefined
      }
      expandable={text.length > 0}
      open={open}
      onToggle={toggle}
      contentId={contentId}
    >
      <OutputBlock>{text || "(no files)"}</OutputBlock>
    </ToolRow>
  );
}

function PlanTool({ status, input }: RendererProps) {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  const done = todos.filter(
    (todo) =>
      todo &&
      typeof todo === "object" &&
      (todo as Record<string, unknown>).status === "done",
  ).length;
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Updating", "Updated")}
      target="plan"
      meta={todos.length > 0 ? `${done}/${todos.length}` : undefined}
    />
  );
}

function GenericTool({ item, status, input }: RendererProps) {
  const target =
    stringField(input, "command") ??
    stringField(input, "path") ??
    stringField(input, "query") ??
    stringField(input, "pattern") ??
    stringField(input, "url") ??
    item.toolName;
  const expandable = item.input !== undefined || item.output !== undefined;
  const { open, toggle } = useDisclosure(false);
  const contentId = `tool-${item.toolCallId}`;
  return (
    <ToolRow
      status={status}
      verb={verbFor(status, "Using", "Used")}
      target={<span className="truncate">{target}</span>}
      expandable={expandable}
      open={open}
      onToggle={toggle}
      contentId={contentId}
    >
      {item.input !== undefined ? (
        <OutputBlock>{pretty(item.input)}</OutputBlock>
      ) : null}
      {item.output !== undefined ? (
        <OutputBlock className="mt-2">{pretty(item.output)}</OutputBlock>
      ) : null}
    </ToolRow>
  );
}

const TOOL_RENDERERS: Record<
  string,
  (props: RendererProps) => ReactNode
> = {
  // Canonical agent tool names.
  bash: BashTool,
  read_file: ReadTool,
  write_file: WriteTool,
  edit_file: EditTool,
  list_dir: ListTool,
  grep: SearchTool,
  glob: GlobTool,
  semantic_search: SearchTool,
  todo_write: PlanTool,
  // Explicit aliases so a Read-like name can never fall through to Bash.
  read: ReadTool,
  write: WriteTool,
  edit: EditTool,
  list: ListTool,
  shell: BashTool,
  run: BashTool,
};

export function ToolCallRow({
  item,
  cancelled = false,
}: {
  item: StreamItem;
  cancelled?: boolean;
}) {
  if (item.kind !== "tool") return null;
  const status = toolStatus(item, cancelled);
  const input = parseInput(item.input);
  // Explicit name → renderer map. Unknown tools get the generic JSON renderer,
  // never a neighboring tool's renderer.
  const Renderer =
    TOOL_RENDERERS[item.toolName] ??
    TOOL_RENDERERS[item.toolName.toLowerCase()] ??
    GenericTool;
  return <Renderer item={item} status={status} input={input} />;
}
