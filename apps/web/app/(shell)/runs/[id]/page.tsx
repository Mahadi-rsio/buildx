"use client";

import Link from "next/link";
import { X } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isContextWindowTokens,
  isTerminalStatus,
  type ContextWindowTokens,
  type ConversationTurn,
} from "@buildx/shared";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
import { ContextStatsPanel } from "@/components/context-stats-panel";
import { PanelSplit } from "@/components/shell/panel-split";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useShell, useShellMeta } from "@/components/shell/shell-context";
import type { WorkspaceData } from "@/components/shell/right-panel";
import { useCreateRun } from "@/hooks/use-create-run";
import { useRunStream } from "@/hooks/use-run-stream";
import { useWorkspaceDiff } from "@/hooks/use-workspace-diff";
import { useWorkspaceFiles } from "@/hooks/use-workspace-files";
import { buildChatMessages, type ChatMessage } from "@/lib/chat-messages";
import { newConversationId } from "@/lib/conversation-id";
import { enqueueConversationEvent } from "@/lib/conversation-sync";

/** Final assistant prose, for the synced conversation log. */
function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    return message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .join("\n\n")
      .trim()
      .slice(0, 100_000);
  }
  return "";
}

const FILE_POLL_MS = 3000;

interface QueuedTurn {
  id: string;
  task: string;
  model?: string;
  contextWindow: ContextWindowTokens;
}

function isQueuedTurn(value: unknown): value is QueuedTurn {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<QueuedTurn>;
  return (
    typeof item.id === "string" &&
    typeof item.task === "string" &&
    item.task.trim().length > 0 &&
    (item.model === undefined || typeof item.model === "string") &&
    isContextWindowTokens(item.contextWindow)
  );
}

function queueStorageKey(conversationId: string | undefined): string | null {
  return conversationId ? `buildx.queue.${conversationId}` : null;
}

/** Flatten the visible thread into turns for the follow-up run. */
function toHistory(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const content = message.blocks
      .filter((block) => block.kind === "text")
      .map((block) => block.text ?? "")
      .join("\n\n")
      .trim();
    if (content.length > 0) {
      turns.push({ role: message.role, content });
    }
  }
  return turns.slice(-100);
}

export default function RunPage() {
  const params = useParams<{ id: string }>();
  const runId = params?.id ?? "";

  const { run, events, streamError, notFound, loading, stop } =
    useRunStream(runId);
  const { createRun, submitting, error: createError } = useCreateRun();
  const {
    modelOverride,
    setModelOverride,
    contextWindowTokens,
    panelVisible,
  } = useShell();
  const [draft, setDraft] = useState("");
  const [queue, setQueue] = useState<QueuedTurn[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const dispatchInFlightRef = useRef(false);
  const dispatchedRunRef = useRef<string | null>(null);
  const loadedQueueKeyRef = useRef<string | null>(null);
  const queueKey = queueStorageKey(run?.conversationId);

  const status = run?.status ?? "idle";
  useShellMeta({
    status,
    model: run?.model,
    runId,
    workspaceId: run?.workspaceId,
    task: run?.task,
    steps: run?.stats?.steps,
    tokens: run?.stats?.usage?.totalTokens,
    contextWindowTokens: run?.contextWindowTokens,
    context: run?.stats?.context,
    startedAt: run?.startedAt,
    endedAt: run?.endedAt,
    workspace: run?.workspace,
  });

  const running = run !== null && !isTerminalStatus(run.status);

  const files = useWorkspaceFiles(
    run?.workspaceId ?? runId,
    panelVisible,
    running ? FILE_POLL_MS : undefined,
  );

  const diff = useWorkspaceDiff(
    run?.workspaceId ?? runId,
    panelVisible,
    running ? FILE_POLL_MS : undefined,
  );

  const workspace: WorkspaceData | null = run
    ? {
        workspaceId: run.workspaceId,
        events,
        path: files.path,
        listing: files.listing,
        file: files.file,
        filesLoading: files.loading,
        filesError: files.error,
        onNavigate: files.navigate,
        onOpenFile: (target) => void files.openFile(target),
        onBackFromFile: files.backFromFile,
        onRefresh: files.refresh,
        readFileContent: files.readFileContent,
        diff: {
          files: diff.files,
          unchanged: diff.unchanged,
          status: diff.status,
        },
        onOpenFromDiff: (target) => void files.openFile(target),
      }
    : null;

  const messages = useMemo(
    () =>
      run
        ? buildChatMessages({
            runId,
            task: run.task,
            createdAt: run.createdAt,
            events,
            status: run.status,
            usage: run.stats?.usage,
            history: run.history,
          })
        : [],
    [runId, run, events],
  );

  const conversationIdRef = useRef<string>(
    run?.conversationId ?? newConversationId(),
  );
  const syncedAssistantRef = useRef<string | null>(null);

  // Queued turns live in sessionStorage so they survive the route push to the
  // next run. Read synchronously, then publish after an await (set-state rule).
  useEffect(() => {
    if (!queueKey || loadedQueueKeyRef.current === queueKey) return;
    loadedQueueKeyRef.current = queueKey;
    let stored: QueuedTurn[] = [];
    try {
      const raw = window.sessionStorage.getItem(queueKey);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) stored = parsed.filter(isQueuedTurn);
    } catch {
      stored = [];
    }
    void Promise.resolve().then(() => {
      setQueue(stored);
      setQueuePaused(false);
    });
  }, [queueKey]);

  useEffect(() => {
    if (!queueKey || loadedQueueKeyRef.current !== queueKey) return;
    try {
      window.sessionStorage.setItem(queueKey, JSON.stringify(queue));
    } catch {
      // Best-effort; the in-memory queue still works for this run.
    }
  }, [queue, queueKey]);

  // Dispatch the next queued turn once this run reaches a terminal state.
  useEffect(() => {
    if (
      !run ||
      !isTerminalStatus(run.status) ||
      queuePaused ||
      queue.length === 0 ||
      dispatchInFlightRef.current ||
      dispatchedRunRef.current === run.id
    ) {
      return;
    }
    const next = queue[0];
    dispatchInFlightRef.current = true;
    dispatchedRunRef.current = run.id;
    void Promise.resolve()
      .then(async () => {
        setQueue((current) =>
          current.filter((item) => item.id !== next.id),
        );
        const created = await createRun({
          task: next.task,
          model: next.model,
          contextWindow: next.contextWindow,
          history: toHistory(messages),
          conversationId: run.conversationId ?? conversationIdRef.current,
        });
        if (created) return;
        dispatchedRunRef.current = null;
        setQueue((current) =>
          current.some((item) => item.id === next.id)
            ? current
            : [next, ...current],
        );
        setQueuePaused(true);
      })
      .finally(() => {
        dispatchInFlightRef.current = false;
      });
  }, [run, queue, queuePaused, messages, createRun]);

  // Persist the assistant's final answer once the run reaches a terminal state.
  useEffect(() => {
    const conversationId = run?.conversationId;
    if (!run || !conversationId || !isTerminalStatus(run.status)) return;
    if (run.status !== "completed") return;
    const id = `${runId}:assistant`;
    if (syncedAssistantRef.current === id) return;
    const content = lastAssistantText(messages);
    if (content.length === 0) return;
    syncedAssistantRef.current = id;
    enqueueConversationEvent({
      id,
      conversationId,
      seq: Date.now(),
      role: "assistant",
      content,
      kind: "message",
      createdAt: Date.now(),
      runId,
    });
  }, [run, messages, runId]);

  async function send() {
    const task = draft.trim();
    if (task.length === 0 || submitting) return;

    if (running || queue.length > 0) {
      setQueue((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          task,
          model: modelOverride.trim() || undefined,
          contextWindow: contextWindowTokens,
        },
      ]);
      setQueuePaused(false);
      setDraft("");
      return;
    }

    const conversationId = run?.conversationId ?? conversationIdRef.current;
    conversationIdRef.current = conversationId;
    enqueueConversationEvent({
      id: crypto.randomUUID(),
      conversationId,
      seq: Date.now(),
      role: "user",
      content: task,
      kind: "message",
      createdAt: Date.now(),
    });
    const created = await createRun({
      task,
      model: modelOverride.trim() || undefined,
      contextWindow: contextWindowTokens,
      history: toHistory(messages),
      conversationId,
    });
    if (created) setDraft("");
  }

  if (notFound) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          Run <code className="font-mono text-foreground">{runId}</code> no
          longer exists.
        </p>
        <Button
          render={<Link href="/" />}
          nativeButton={false}
          variant="outline"
        >
          Start a new chat
        </Button>
      </div>
    );
  }

  return (
    <PanelSplit workspace={workspace}>
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        {run?.error || streamError || (run && run.stats?.context) ? (
          <div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-4 pt-3 sm:px-6">
            {run && run.stats?.context ? (
              <ContextStatsPanel
                model={run.model}
                context={run.stats.context}
                contextWindowTokens={run.contextWindowTokens}
              />
            ) : null}
            {run?.error ? (
              <Alert variant="destructive">
                <AlertTitle>Run failed</AlertTitle>
                <AlertDescription>{run.error}</AlertDescription>
              </Alert>
            ) : null}
            {streamError ? (
              <Alert className="border-[var(--border)] bg-[var(--surface)]">
                <AlertTitle className="text-[var(--text)]">
                  Stream interrupted
                </AlertTitle>
                <AlertDescription className="text-[var(--text-muted)]">
                  {streamError}
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
        ) : null}

        <ChatThread
          messages={messages}
          loading={loading}
          showThinking={running}
          cancelled={run?.status === "cancelled"}
          status={status}
          onRetry={
            run
              ? () => {
                  void createRun({
                    task: run.task,
                    model: modelOverride.trim() || undefined,
                    contextWindow: run.contextWindowTokens,
                    history: run.history,
                    conversationId: run.conversationId,
                  });
                }
              : undefined
          }
          onEdit={run ? () => setDraft(run.task) : undefined}
        />

        {queue.length > 0 ? (
          <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-1 sm:px-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-medium text-[var(--text)]">
                  Queued · {queue.length}
                </span>
                <span className="text-2xs text-[var(--text-faint)]">
                  {queuePaused
                    ? "Paused after a failed send"
                    : running
                      ? "Sends when this run finishes"
                      : "Ready to send"}
                </span>
                {queuePaused ? (
                  <button
                    type="button"
                    onClick={() => setQueuePaused(false)}
                    className="ml-auto text-2xs font-medium text-[var(--text)] underline-offset-2 hover:underline"
                  >
                    Retry
                  </button>
                ) : null}
              </div>
              <ul className="mt-1.5 space-y-1">
                {queue.map((item) => (
                  <li
                    key={item.id}
                    className="flex items-start gap-2 rounded-md bg-[var(--bg)]/40 px-2 py-1.5"
                  >
                    <span className="mt-0.5 font-mono text-2xs text-[var(--text-faint)]">
                      {item.contextWindow / 1000}k
                    </span>
                    <span className="min-w-0 flex-1 truncate text-xs text-[var(--text-muted)]">
                      {item.task}
                    </span>
                    <button
                      type="button"
                      aria-label="Remove queued message"
                      onClick={() =>
                        setQueue((current) =>
                          current.filter((queued) => queued.id !== item.id),
                        )
                      }
                      className="shrink-0 text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}

        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          onStop={running ? () => void stop() : undefined}
          model={modelOverride}
          onModelChange={setModelOverride}
          submitting={submitting}
          streaming={running}
          error={createError}
          hint="Replies continue this conversation; each turn runs in a fresh workspace"
        />
      </div>
    </PanelSplit>
  );
}
