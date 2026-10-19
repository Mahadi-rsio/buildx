"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RunStatus } from "@buildx/shared";
import {
  ArrowDown,
  Check,
  Copy,
  Download,
  FilePen,
  FilePlus2,
  Files,
} from "lucide-react";
import type { ChatMessage } from "@/lib/chat-messages";
import { ChatMessageView } from "@/components/chat/chat-message";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const STICKY_THRESHOLD = 120;

type FileChange = { path: string; change: string };

function FilesChangedCard({ changes }: { changes: FileChange[] }) {
  const [copied, setCopied] = useState(false);
  const text = changes.map((c) => `${c.change} ${c.path}`).join("\n");

  function download() {
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "buildx-files.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-3 sm:px-6">
      <div className="overflow-hidden rounded-md bg-[var(--surface)]">
        <div className="flex items-center gap-2 px-3 py-2">
          <Files className="size-3.5 shrink-0 text-[var(--text-faint)]" />
          <span className="text-[13px] font-medium text-[var(--text)]">
            Files changed
          </span>
          <span className="font-mono text-2xs text-[var(--text-faint)]">
            {changes.length}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Copy file list"
              onClick={() => {
                void navigator.clipboard.writeText(text).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                }, () => undefined);
              }}
            >
              {copied ? (
                <Check className="size-3" />
              ) : (
                <Copy className="size-3" />
              )}
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Download file list"
              onClick={download}
            >
              <Download className="size-3" />
            </Button>
          </div>
        </div>
        <ul className="px-1.5 py-1.5">
          {changes.map((change) => (
            <li
              key={change.path}
              className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--surface-hover)]"
            >
              {change.change === "create" ? (
                <FilePlus2 className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              ) : (
                <FilePen className="size-3.5 shrink-0 text-[var(--text-muted)]" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--text)]">
                {change.path}
              </span>
              <span className="shrink-0 text-2xs capitalize text-[var(--text-faint)]">
                {change.change}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ChatThread({
  messages,
  loading,
  showThinking,
  cancelled,
  status,
  onRetry,
  onEdit,
}: {
  messages: ChatMessage[];
  loading?: boolean;
  showThinking?: boolean;
  /** Run was cancelled/stopped — render pending steps as cancelled. */
  cancelled?: boolean;
  /** Terminal run status, used to show the files-changed summary. */
  status?: RunStatus | "idle";
  onRetry?: () => void;
  onEdit?: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [nearBottom, setNearBottom] = useState(true);

  const fileChanges = useMemo(() => {
    const map = new Map<string, FileChange>();
    for (const message of messages) {
      for (const block of message.blocks) {
        if (block.item?.kind === "file_change") {
          map.set(block.item.path, {
            path: block.item.path,
            change: block.item.change,
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [messages]);

  const showSummary = status === "completed" && fileChanges.length > 0;

  const updateFollow = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance < STICKY_THRESHOLD;
    setNearBottom(stickToBottomRef.current);
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener("scroll", updateFollow, { passive: true });
    return () => el.removeEventListener("scroll", updateFollow);
  }, []);

  // Follow new/streamed content only while the user is already near the bottom.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, showThinking, showSummary]);

  const jumpToLatest = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    setNearBottom(true);
    el.scrollTop = el.scrollHeight;
  };

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4 px-4 py-8">
        <Skeleton className="ml-auto h-20 w-3/4 rounded-lg" />
        <Skeleton className="h-28 w-4/5 rounded-lg" />
        <Skeleton className="h-16 w-2/3 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollerRef}
        className={cn(
          "absolute inset-0 overflow-y-auto overscroll-contain",
        )}
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-3 py-6 pb-10 sm:px-6 sm:py-8">
          {messages.map((message, index) => (
            <ChatMessageView
              key={message.id}
              message={message}
              showThinking={
                showThinking &&
                message.role === "assistant" &&
                index === messages.length - 1
              }
              cancelled={cancelled}
              onRetry={
                message.role === "assistant" && !message.historical
                  ? onRetry
                  : undefined
              }
              onEdit={
                message.role === "user" && !message.historical
                  ? onEdit
                  : undefined
              }
            />
          ))}
          {showSummary ? <FilesChangedCard changes={fileChanges} /> : null}
        </div>
      </div>

      {!nearBottom ? (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={jumpToLatest}
            className="pointer-events-auto h-8 gap-1.5 shadow-sm"
          >
            <ArrowDown className="size-3.5" />
            Jump to latest
          </Button>
        </div>
      ) : null}
    </div>
  );
}
