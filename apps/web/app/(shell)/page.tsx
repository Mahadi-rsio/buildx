"use client";

import { useRef, useState } from "react";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatEmptyState } from "@/components/chat/empty-state";
import { PanelSplit } from "@/components/shell/panel-split";
import { useShell, useShellMeta } from "@/components/shell/shell-context";
import { useCreateRun } from "@/hooks/use-create-run";
import { useSkills } from "@/hooks/use-skills";
import { newConversationId } from "@/lib/conversation-id";
import { enqueueConversationEvent } from "@/lib/conversation-sync";

export default function NewChatPage() {
  useShellMeta({ status: "idle" });

  const { createRun, submitting, error } = useCreateRun();
  const { skills, loading: skillsLoading } = useSkills();
  const { modelOverride, setModelOverride, contextWindowTokens } = useShell();
  const [draft, setDraft] = useState("");
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const conversationIdRef = useRef<string | null>(null);

  async function send() {
    const task = draft.trim();
    if (task.length === 0 || submitting) return;
    const conversationId = conversationIdRef.current ?? newConversationId();
    conversationIdRef.current = conversationId;
    // Local-first: the user's message lands in the queue (and on screen) before
    // the network call; sync creates the conversation server-side if needed.
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
      skillNames: selectedSkills,
      conversationId,
    });
    if (created) {
      setDraft("");
      setSelectedSkills([]);
    }
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
          skills={skills ?? []}
          skillsLoading={skillsLoading}
          selectedSkills={selectedSkills}
          onSelectedSkillsChange={setSelectedSkills}
          submitting={submitting}
          error={error}
          hint="Each message starts a new run in a fresh workspace"
        />
      </div>
    </PanelSplit>
  );
}
