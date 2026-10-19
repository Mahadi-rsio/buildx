"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { isTerminalStatus } from "@buildx/shared";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatThread } from "@/components/chat/chat-thread";
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
import type { ConversationTurn } from "@buildx/shared";

const FILE_POLL_MS = 3000;

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
  const { modelOverride, setModelOverride, panelVisible } = useShell();
  const [draft, setDraft] = useState("");

  const status = run?.status ?? "idle";
  useShellMeta({
    status,
    model: run?.model,
    runId,
    workspaceId: run?.workspaceId,
    task: run?.task,
    steps: run?.stats?.steps,
    tokens: run?.stats?.usage?.totalTokens,
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

  async function send() {
    const task = draft.trim();
    if (task.length === 0 || submitting) return;
    const created = await createRun({
      task,
      model: modelOverride.trim() || undefined,
      history: toHistory(messages),
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
        {run?.error || streamError ? (
          <div className="mx-auto w-full max-w-3xl shrink-0 space-y-2 px-4 pt-3 sm:px-6">
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
                    history: run.history,
                  });
                }
              : undefined
          }
          onEdit={run ? () => setDraft(run.task) : undefined}
        />

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
