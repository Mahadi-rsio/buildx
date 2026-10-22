"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import type { ContextWindowTokens, ConversationTurn } from "@buildx/shared";
import { getQueryClient } from "@/lib/query-client";
import { quotaQueryKey } from "@/hooks/use-quota";
import { runsQueryKey } from "@/hooks/use-runs";
import { useShell } from "@/components/shell/shell-context";
import { isDailyLimitMessage } from "@/lib/quota-errors";

export function useCreateRun() {
  const router = useRouter();
  const { setUpgradeOpen } = useShell();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createRun = useCallback(
    async (args: {
      task: string;
      model?: string;
      contextWindow?: ContextWindowTokens;
      history?: ConversationTurn[];
      skillNames?: string[];
      conversationId?: string;
      repository?: string;
      idempotencyKey?: string;
      clientMessageId?: string;
      resumeFromRunId?: string;
    }) => {
      const trimmed = args.task.trim();
      if (trimmed.length === 0 || submitting) return null;

      setSubmitting(true);
      setError(null);
      try {
        const res = await fetch("/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            task: trimmed,
            model: args.model?.trim() || undefined,
            contextWindow: args.contextWindow,
            history: args.history?.length ? args.history : undefined,
            skillNames: args.skillNames?.length ? args.skillNames : undefined,
            conversationId: args.conversationId,
            repository: args.repository,
            idempotencyKey: args.idempotencyKey,
            clientMessageId: args.clientMessageId,
            resumeFromRunId: args.resumeFromRunId,
          }),
        });
        const contentType = res.headers.get("content-type") ?? "";
        let data: { id?: string; message?: string; error?: string } = {};
        if (contentType.includes("application/json")) {
          data = (await res.json().catch(() => ({}))) as typeof data;
        } else {
          const text = await res.text().catch(() => "");
          data = { message: text || `HTTP ${res.status} ${res.statusText}` };
        }

        if (!res.ok || !data.id) {
          const message =
            data.message ?? data.error ?? "Could not start the run";
          setError(message);
          if (isDailyLimitMessage(message)) setUpgradeOpen(true);
          return null;
        }
        const client = getQueryClient();
        void client.invalidateQueries({ queryKey: runsQueryKey() });
        void client.invalidateQueries({ queryKey: quotaQueryKey() });
        router.push(`/runs/${data.id}`);
        return data.id;
      } catch (err) {
        setError(
          err instanceof Error && err.message
            ? `Failed to start run: ${err.message}`
            : "Network error — is the dev server running?",
        );
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [router, submitting, setUpgradeOpen],
  );

  return { createRun, submitting, error, setError };
}
