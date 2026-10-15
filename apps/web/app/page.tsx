"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { StatusBadge } from "@/components/status-badge";
import { formatAgo } from "@/lib/format";
import type { RunSummary } from "@/lib/types";

const SAMPLE_TASK =
  "Create src/greet.ts exporting a `greet(name: string)` function, add a " +
  "README.md showing how to use it, and verify the file reads back correctly.";

interface Config {
  hasApiKey: boolean;
  model: string;
  maxSteps: number;
}

export default function HomePage() {
  const router = useRouter();
  const [task, setTask] = useState(SAMPLE_TASK);
  const [model, setModel] = useState("");
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;

    const configPromise = fetch("/api/config")
      .then((res) => res.json())
      .then((data: Config) => {
        if (alive) setConfig(data);
      })
      .catch(() => undefined);

    const loadRuns = () =>
      fetch("/api/runs")
        .then((res) => res.json())
        .then((data: { runs?: RunSummary[] }) => {
          if (alive) setRuns(data.runs ?? []);
        })
        .catch(() => undefined);

    void configPromise;
    void loadRuns();
    const timer = window.setInterval(() => void loadRuns(), 4000);

    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = task.trim();
    if (trimmed.length === 0 || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: trimmed,
          model: model.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { id?: string; message?: string; error?: string };
      if (!res.ok || !data.id) {
        setError(data.message ?? data.error ?? "could not start the run");
        return;
      }
      router.push(`/runs/${data.id}`);
    } catch {
      setError("network error — is the dev server running?");
    } finally {
      setSubmitting(false);
    }
  }

  const active = runs.some(
    (run) => run.status === "running" || run.status === "queued",
  );

  return (
    <div className="space-y-8">
      {config && !config.hasApiKey ? (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          <span className="font-medium">No API key configured.</span> Copy{" "}
          <code className="font-mono">.env.example</code> to{" "}
          <code className="font-mono">.env.local</code>, set{" "}
          <code className="font-mono">OPENAI_API_KEY</code>, and restart the dev
          server. Runs cannot start until then.
        </div>
      ) : null}

      <section>
        <h1 className="font-mono text-lg font-semibold">Start a run</h1>
        <p className="mt-1 text-sm text-neutral-400">
          The agent gets its own workspace directory, a sandboxed tool loop, and
          streams every step back as an append-only event.
          {config ? ` Defaults: ${config.model}, ${config.maxSteps} steps.` : ""}
        </p>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            rows={4}
            placeholder="Describe the file read/write task…"
            className="w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2.5 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={config ? `model (${config.model})` : "model"}
              className="w-64 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 font-mono text-sm outline-none placeholder:text-neutral-600 focus:border-neutral-600"
            />
            <button
              type="submit"
              disabled={submitting || task.trim().length === 0}
              className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "Starting…" : "Run agent"}
            </button>
            {error ? (
              <span className="text-sm text-red-400">{error}</span>
            ) : null}
          </div>
        </form>
      </section>

      <section>
        <div className="flex items-center justify-between">
          <h2 className="font-mono text-sm font-semibold uppercase tracking-wide text-neutral-400">
            Runs
            {active ? (
              <span className="ml-2 text-amber-400">· updating</span>
            ) : null}
          </h2>
          <span className="text-xs text-neutral-600">{runs.length} total</span>
        </div>

        {runs.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">
            No runs yet. Start one above.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-900 overflow-hidden rounded-lg border border-neutral-900">
            {runs.map((run) => (
              <li key={run.id}>
                <Link
                  href={`/runs/${run.id}`}
                  className="flex items-center gap-4 px-4 py-3 transition hover:bg-neutral-900/60"
                >
                  <StatusBadge status={run.status} />
                  <span className="min-w-0 flex-1 truncate text-sm text-neutral-200">
                    {run.task}
                  </span>
                  <span className="hidden font-mono text-[11px] text-neutral-600 sm:block">
                    {run.eventCount} events
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-neutral-500">
                    {formatAgo(run.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
