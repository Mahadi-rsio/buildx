"use client";

import { useEffect, useMemo, useState } from "react";
import type { RunEvent, TodoItem } from "@buildx/shared";
import {
  Boxes,
  Eye,
  FileCode2,
  FolderIcon,
  FolderTree,
  MemoryStick,
  RefreshCw,
  TerminalSquare,
} from "lucide-react";
import { latestTodos } from "@/components/run-events";
import { CodeComparison } from "@/components/ui/code-comparison";
import { File, Tree, type TreeViewElement } from "@/components/ui/file-tree";
import { NumberTicker } from "@/components/ui/number-ticker";
import { Terminal } from "@/components/ui/terminal";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  collectFileChanges,
  collectTerminalOutput,
  guessLanguage,
} from "@/lib/chat-messages";
import type { FileContentResponse, FilesResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

function listingToTree(listing: FilesResponse | null): TreeViewElement[] {
  if (!listing) return [];
  return listing.entries.map((entry) => ({
    id: entry.path,
    name: entry.name,
    type: entry.type === "dir" ? "folder" : "file",
    isSelectable: true,
    children: entry.type === "dir" ? [] : undefined,
  }));
}

function Unavailable({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm font-medium text-foreground/90">{title}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

export function WorkspacePanel({
  workspaceId,
  events,
  path,
  listing,
  file,
  filesError,
  onNavigate,
  onOpenFile,
  onBackFromFile,
  onRefresh,
  readFileContent,
  tab,
  onTabChange,
  className,
}: {
  workspaceId: string;
  events: RunEvent[];
  path: string;
  listing: FilesResponse | null;
  file: FileContentResponse | null;
  filesError: string | null;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onBackFromFile: () => void;
  onRefresh: () => void;
  readFileContent: (path: string) => Promise<string | null>;
  /** Controlled active tab (defaults to uncontrolled "files"). */
  tab?: string;
  onTabChange?: (tab: string) => void;
  className?: string;
}) {
  const changes = useMemo(() => collectFileChanges(events), [events]);
  const terminalOutput = useMemo(() => collectTerminalOutput(events), [events]);
  const todos = useMemo(() => latestTodos(events), [events]);
  const tree = useMemo(() => listingToTree(listing), [listing]);

  const [selectedChange, setSelectedChange] = useState<string | null>(null);
  const [afterCode, setAfterCode] = useState("");
  const [loadingDiff, setLoadingDiff] = useState(false);

  const activeChange =
    selectedChange && changes.some((c) => c.path === selectedChange)
      ? selectedChange
      : (changes[0]?.path ?? null);

  useEffect(() => {
    if (!activeChange) return;
    let alive = true;
    void (async () => {
      const content = await readFileContent(activeChange);
      if (!alive) return;
      setAfterCode(content ?? "");
      setLoadingDiff(false);
    })();
    return () => {
      alive = false;
    };
  }, [activeChange, readFileContent, events.length]);

  useEffect(() => {
    if (!activeChange) return;
    let alive = true;
    void (async () => {
      await Promise.resolve();
      if (alive) setLoadingDiff(true);
    })();
    return () => {
      alive = false;
    };
  }, [activeChange, events.length]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-sidebar/40", className)}>
      <Tabs
        value={tab}
        defaultValue="files"
        onValueChange={(next) => onTabChange?.(String(next))}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        <div className="border-b border-border px-2 py-2">
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
            <TabsTrigger value="files" className="gap-1.5 px-2.5 text-xs">
              <FolderTree className="size-3.5" />
              Files
            </TabsTrigger>
            <TabsTrigger value="changes" className="gap-1.5 px-2.5 text-xs">
              <FileCode2 className="size-3.5" />
              Changes
              {changes.length > 0 ? (
                <span className="font-mono text-[10px] text-muted-foreground">
                  <NumberTicker value={changes.length} className="text-muted-foreground" />
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="terminal" className="gap-1.5 px-2.5 text-xs">
              <TerminalSquare className="size-3.5" />
              Terminal
            </TabsTrigger>
            <TabsTrigger value="preview" className="gap-1.5 px-2.5 text-xs">
              <Eye className="size-3.5" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="mcp" className="gap-1.5 px-2.5 text-xs">
              <Boxes className="size-3.5" />
              MCP
            </TabsTrigger>
            <TabsTrigger value="memory" className="gap-1.5 px-2.5 text-xs">
              <MemoryStick className="size-3.5" />
              Memory
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="files" className="min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {file ? file.path : path}
              </span>
              {file ? (
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={onBackFromFile}
                >
                  Tree
                </Button>
              ) : null}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Refresh files"
                onClick={onRefresh}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
            {filesError ? (
              <p className="px-3 py-3 text-xs text-red-400">{filesError}</p>
            ) : file ? (
              <ScrollArea className="min-h-0 flex-1">
                <div className="p-3">
                  <p className="mb-2 font-mono text-[11px] text-muted-foreground">
                    {file.size} bytes
                    {file.binary ? " · binary (not shown)" : ""}
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
                    {file.binary ? "" : file.content}
                  </pre>
                </div>
              </ScrollArea>
            ) : tree.length === 0 ? (
              <p className="px-3 py-3 text-xs text-muted-foreground">
                Empty workspace — files appear as the agent writes them.
              </p>
            ) : (
              <div className="min-h-0 flex-1 overflow-hidden p-2">
                {path !== "." ? (
                  <div className="mb-2 px-1">
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        const parts = path.split("/").filter(Boolean);
                        parts.pop();
                        onNavigate(parts.length ? parts.join("/") : ".");
                      }}
                    >
                      Up to parent
                    </Button>
                  </div>
                ) : null}
                <Tree
                  className="h-full"
                  elements={tree}
                  initialExpandedItems={[]}
                  indicator={false}
                >
                  {tree.map((el) => (
                    <File
                      key={el.id}
                      value={el.id}
                      fileIcon={
                        el.type === "folder" ? (
                          <FolderIcon className="size-4 text-amber-300/90" />
                        ) : undefined
                      }
                      handleSelect={(id) => {
                        if (el.type === "folder") onNavigate(id);
                        else void onOpenFile(id);
                      }}
                    >
                      {el.name}
                    </File>
                  ))}
                </Tree>
              </div>
            )}
            <p className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
              workspace/{workspaceId.slice(0, 10)}
            </p>
          </div>
        </TabsContent>

        <TabsContent value="changes" className="min-h-0 flex-1 overflow-hidden">
          {changes.length === 0 ? (
            <Unavailable
              title="No file changes yet"
              detail="Edits stream here from real file_change events as the agent writes."
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col">
              <ScrollArea className="max-h-28 border-b border-border">
                <ul className="p-2">
                  {changes.map((change) => (
                    <li key={change.path}>
                      <button
                        type="button"
                        onClick={() => setSelectedChange(change.path)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11px] transition hover:bg-muted/50",
                          activeChange === change.path && "bg-muted/60",
                        )}
                      >
                        <span className="text-emerald-400">{change.change}</span>
                        <span className="truncate text-foreground/85">
                          {change.path}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
              <div className="min-h-0 flex-1 overflow-auto p-2">
                {activeChange ? (
                  loadingDiff ? (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      Loading diff…
                    </p>
                  ) : (
                    <CodeComparison
                      beforeCode=""
                      afterCode={afterCode}
                      language={guessLanguage(activeChange)}
                      filename={activeChange}
                      lightTheme="github-light"
                      darkTheme="github-dark"
                    />
                  )
                ) : null}
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="terminal" className="min-h-0 flex-1 overflow-hidden p-3">
          {terminalOutput.length === 0 ? (
            <Unavailable
              title="No terminal output"
              detail="Stdout and stderr from tool executions appear here when emitted."
            />
          ) : (
            <Terminal
              sequence={false}
              className="h-full max-h-none max-w-none overflow-auto"
            >
              <span className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-foreground/85">
                {terminalOutput}
              </span>
            </Terminal>
          )}
        </TabsContent>

        <TabsContent value="preview" className="min-h-0 flex-1">
          <Unavailable
            title="Preview unavailable"
            detail="No preview URL is exposed by the current sandbox API. This tab will activate when a workspace preview endpoint lands."
          />
        </TabsContent>

        <TabsContent value="mcp" className="min-h-0 flex-1">
          <Unavailable
            title="MCP & skills not configured"
            detail="MCP server management is not wired in this phase. Nothing here is simulated as connected."
          />
        </TabsContent>

        <TabsContent value="memory" className="min-h-0 flex-1 overflow-auto p-4">
          <MemoryPanel todos={todos} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MemoryPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) {
    return (
      <Unavailable
        title="No project memory yet"
        detail="The agent's todo/plan events will show here as working memory for this run."
      />
    );
  }
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Agent plan</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Live todos from the current run (not persisted project memory).
        </p>
      </div>
      <ul className="space-y-2">
        {todos.map((todo, index) => (
          <li
            key={`${todo.content}-${index}`}
            className={cn(
              "rounded-lg border border-border px-3 py-2 text-xs",
              todo.status === "done" && "text-muted-foreground line-through",
              todo.status === "in_progress" && "border-amber-500/30 text-amber-200",
            )}
          >
            <span className="font-mono text-[10px] uppercase text-muted-foreground">
              {todo.status}
            </span>
            <p className="mt-1">{todo.content}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
