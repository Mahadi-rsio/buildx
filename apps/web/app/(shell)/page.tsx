"use client";

import { useState } from "react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatEmptyState } from "@/components/chat/empty-state";
import { PanelSplit } from "@/components/shell/panel-split";
import { useShell, useShellMeta } from "@/components/shell/shell-context";
import { useCreateRun } from "@/hooks/use-create-run";

export default function NewChatPage() {
  useShellMeta({ status: "idle" });

  const { createRun, submitting, error } = useCreateRun();
  const { modelOverride, setModelOverride } = useShell();
  const [draft, setDraft] = useState("");

  async function send() {
    const task = draft.trim();
    if (task.length === 0 || submitting) return;
    const created = await createRun({
      task,
      model: modelOverride.trim() || undefined,
    });
    if (created) setDraft("");
  }

  return (
    <PanelSplit workspace={null}>
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <ChatEmptyState onSelect={(prompt) => setDraft(prompt)} />
        <ChatComposer
          value={draft}
          onChange={setDraft}
          onSubmit={() => void send()}
          model={modelOverride}
          onModelChange={setModelOverride}
          submitting={submitting}
          error={error}
          hint="Each message starts a new run in a fresh workspace"
        />
      </div>
    </PanelSplit>
  );
}
