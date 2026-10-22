"use client";

import Link from "next/link";
import { BookOpen, X } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  isContextWindowTokens,
  isTerminalStatus,
  type ApprovalPayload,
  type ContextWindowTokens,
  type ConversationTurn,
} from "@buildx/shared";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
import { ContextStatsPanel } from "@/components/context-stats-panel";
import { RunFailureCard } from "@/components/chat/run-failure-card";
import { PanelSplit } from "@/components/shell/panel-split";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useShell, useShellMeta } from "@/components/shell/shell-context";
import type { WorkspaceData } from "@/components/shell/right-panel";
import { useCreateRun } from "@/hooks/use-create-run";
import { useRunStream } from "@/hooks/use-run-stream";
import { useSkills } from "@/hooks/use-skills";
import { useWorkspaceDiff } from "@/hooks/use-workspace-diff";
import { useWorkspaceFiles } from "@/hooks/use-workspace-files";
import { useQuota } from "@/hooks/use-quota";
import { buildChatMessages, type ChatMessage } from "@/lib/chat-messages";
import { newConversationId } from "@/lib/conversation-id";
import { enqueueConversationEvent } from "@/lib/conversation-sync";
import { isDailyLimitMessage } from "@/lib/quota-errors";

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
  skillNames?: string[];
}

interface OptimisticMessage {
  id: string;
  task: string;
  conversationId?: string;
  createdAt: number;
  queued?: boolean;
}

function isQueuedTurn(value: unknown): value is QueuedTurn {
  if (value === null || typeof value !== "object") return false;
  const item = value as Partial<QueuedTurn>;
  return (
    typeof item.id === "string" &&
    typeof item.task === "string" &&
    item.task.trim().length > 0 &&
    (item.model === undefined || typeof item.model === "string") &&
    isContextWindowTokens(item.contextWindow) &&
    (item.skillNames === undefined ||
      (Array.isArray(item.skillNames) &&
        item.skillNames.every((name) => typeof name === "string")))
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
  const { skills, loading: skillsLoading } = useSkills();
  const {
    modelOverride,
    setModelOverride,
    contextWindowTokens,
    panelVisible,
    setUpgradeOpen,
  } = useShell();
  const [draft, setDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [queue, setQueue] = useState<QueuedTurn[]>([]);
  const [queuePaused, setQueuePaused] = useState(false);
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([]);
  const [answerText, setAnswerText] = useState("");
  const [answerSending, setAnswerSending] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [answeredIds, setAnsweredIds] = useState<string[]>([]);
  const dispatchInFlightRef = useRef(false);
  const sendInFlightRef = useRef(false);
  const dispatchedRunRef = useRef<string | null>(null);
  const loadedQueueKeyRef = useRef<string | null>(null);
  const queueKey = queueStorageKey(run?.conversationId);

  const status = run?.status ?? "idle";
  const limitReached = isDailyLimitMessage(run?.error);
  const quota = useQuota(Boolean(run?.error && limitReached));
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

  const preloadedSkills = useMemo(() => {
    const names = new Set<string>();
    for (const event of events) {
      if (event.type !== "tool_result") continue;
      const output = event.data.output;
      if (output === null || typeof output !== "object") continue;
      const record = output as Record<string, unknown>;
      if (record.preloaded === true && typeof record.skill === "string") {
        names.add(record.skill);
      }
    }
    return names;
  }, [events]);
  const skillsReady =
    run?.skillNames?.length
      ? run.skillNames.every((name) => preloadedSkills.has(name))
      : false;

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
          error: diff.error,
          fallbackFiles: diff.fallbackFiles,
          onRefresh: diff.refresh,
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
            skillNames: run.skillNames,
            skillsReady,
            skillsLoading:
              running && Boolean(run.skillNames?.length) && !skillsReady,
          })
        : [],
    [runId, run, events, running, skillsReady],
  );

  const visibleMessages = useMemo<ChatMessage[]>(() => {
    const pending = optimistic
      .filter(
        (item) =>
          !(
            run &&
            run.task.trim() === item.task.trim() &&
            (!item.conversationId ||
              !run.conversationId ||
              item.conversationId === run.conversationId)
          ),
      )
      .map((item) => ({
        id: `optimistic-${item.id}`,
        role: "user" as const,
        createdAt: item.createdAt,
        optimistic: true,
        queued: item.queued,
        blocks: [
          {
            id: `optimistic-${item.id}-text`,
            kind: "text" as const,
            text: item.task,
          },
        ],
      }));
    return [...messages, ...pending];
  }, [messages, optimistic, run]);

  const pendingApproval = useMemo<ApprovalPayload | null>(() => {
    let pending: ApprovalPayload | null = null;
    for (const event of events) {
      if (event.type !== "approval") continue;
      if (event.data.status === "pending") {
        if (!answeredIds.includes(event.data.toolCallId)) pending = event.data;
      } else if (
        pending &&
        event.data.toolCallId === pending.toolCallId
      ) {
        pending = null;
      }
    }
    return pending;
  }, [events, answeredIds]);

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
          skillNames: next.skillNames,
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

  async function answerPending(value: string) {
    const question = pendingApproval;
    if (!question || answerSending || value.trim().length === 0) return;
    setAnswerSending(true);
    setAnswerError(null);
    try {
      const res = await fetch(`/api/runs/${runId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toolCallId: question.toolCallId,
          answer: value.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
      };
      if (!res.ok) {
        setAnswerError(data.message ?? "Could not send that answer.");
        return;
      }
      setAnsweredIds((current) => [...current, question.toolCallId]);
      setAnswerText("");
    } catch {
      setAnswerError("Network error — your answer was kept. Try again.");
    } finally {
      setAnswerSending(false);
    }
  }

  async function send() {
    const task = draft.trim();
    if (task.length === 0 || submitting || sendInFlightRef.current) return;
    sendInFlightRef.current = true;

    const clientMessageId = crypto.randomUUID();
    const conversationId = run?.conversationId ?? conversationIdRef.current;
    conversationIdRef.current = conversationId;
    const skillsForTurn =
      selectedSkills.length > 0 ? selectedSkills : undefined;

    // Optimistic UI: the message and queued/running state land immediately,
    // before the network call and without waiting for the model.
    setOptimistic((current) => [
      ...current,
      {
        id: clientMessageId,
        task,
        conversationId,
        createdAt: Date.now(),
        queued: running || queue.length > 0,
      },
    ]);
    setDraft("");
    setSelectedSkills([]);
    enqueueConversationEvent({
      id: clientMessageId,
      conversationId,
      seq: Date.now(),
      role: "user",
      content: task,
      kind: "message",
      createdAt: Date.now(),
    });

    try {
      if (running || queue.length > 0) {
        setQueue((current) => [
          ...current,
          {
            id: clientMessageId,
            task,
            model: modelOverride.trim() || undefined,
            contextWindow: contextWindowTokens,
            skillNames: skillsForTurn,
          },
        ]);
        setQueuePaused(false);
        return;
      }

      const created = await createRun({
        task,
        model: modelOverride.trim() || undefined,
        contextWindow: contextWindowTokens,
        skillNames: skillsForTurn,
        history: toHistory(messages),
        conversationId,
        idempotencyKey: clientMessageId,
        clientMessageId,
        resumeFromRunId:
          run && (run.status === "cancelled" || run.status === "waiting_input")
            ? run.id
            : undefined,
      });
      if (!created) {
        // Preserve the text and skills so the user can retry without retyping.
        setOptimistic((current) =>
          current.filter((item) => item.id !== clientMessageId),
        );
        setDraft((current) => (current.length > 0 ? current : task));
        if (skillsForTurn) setSelectedSkills(skillsForTurn);
      }
    } finally {
      sendInFlightRef.current = false;
    }
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
              <RunFailureCard
                reason={run.error}
                resetAt={quota.data?.resetAt}
                onAddCredit={() => setUpgradeOpen(true)}
                onRetry={() => {
                  void createRun({
                    task: run.task,
                    model: modelOverride.trim() || undefined,
                    contextWindow: run.contextWindowTokens,
                    skillNames: run.skillNames,
                    history: run.history,
                    conversationId: run.conversationId,
                  });
                }}
              />
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
          messages={visibleMessages}
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
                    skillNames: run.skillNames,
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
                    {item.skillNames?.length ? (
                      <span
                        className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 text-2xs text-[var(--text-faint)]"
                        title={`Skills: ${item.skillNames.join(", ")}`}
                      >
                        <BookOpen className="size-2.5" />
                        {item.skillNames.length}
                      </span>
                    ) : null}
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

        {run?.status === "waiting_input" &&
        pendingApproval?.question &&
        !answeredIds.includes(pendingApproval.toolCallId) ? (
          <div className="mx-auto w-full max-w-3xl shrink-0 px-3 pb-1 sm:px-4">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-faint)]">
                Waiting for your answer
              </p>
              <p className="mt-1 whitespace-pre-wrap text-[13px] text-[var(--text)]">
                {pendingApproval.question}
              </p>
              {pendingApproval.options && pendingApproval.options.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pendingApproval.options.map((option) => (
                    <Button
                      key={option.id}
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={answerSending}
                      onClick={() => void answerPending(option.id)}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              ) : (
                <form
                  className="mt-2 flex items-center gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void answerPending(answerText);
                  }}
                >
                  <input
                    value={answerText}
                    onChange={(event) => setAnswerText(event.target.value)}
                    placeholder="Type your answer…"
                    aria-label="Answer"
                    className="h-8 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-xs text-[var(--text)] outline-none focus:border-[var(--text-muted)]"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={answerSending || answerText.trim().length === 0}
                  >
                    Answer
                  </Button>
                </form>
              )}
              {answerError ? (
                <p className="mt-1.5 text-2xs text-destructive">{answerError}</p>
              ) : null}
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
          skills={skills ?? []}
          skillsLoading={skillsLoading}
          selectedSkills={selectedSkills}
          onSelectedSkillsChange={setSelectedSkills}
          submitting={submitting}
          streaming={running}
          error={createError}
          hint="Replies continue this conversation; each turn runs in a fresh workspace"
        />
      </div>
    </PanelSplit>
  );
}
