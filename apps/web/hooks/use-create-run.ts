"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

export function useCreateRun() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createRun = useCallback(
    async (args: { task: string; model?: string }) => {
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
          }),
        });
        const data = (await res.json()) as {
          id?: string;
          message?: string;
          error?: string;
        };
        if (!res.ok || !data.id) {
          setError(data.message ?? data.error ?? "Could not start the run");
          return null;
        }
        router.push(`/runs/${data.id}`);
        return data.id;
      } catch {
        setError("Network error — is the dev server running?");
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [router, submitting],
  );

  return { createRun, submitting, error, setError };
}
