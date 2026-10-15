"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  Sparkles,
  XCircle,
} from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatAgo } from "@/lib/format";
import type { RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const TEMPLATES = [
  {
    id: "greet",
    label: "Hello module",
    task:
      "Create src/greet.ts exporting a `greet(name: string)` function, add a " +
      "README.md showing how to use it, and verify the file reads back correctly.",
  },
  {
    id: "cli",
    label: "Tiny CLI",
    task:
      "Scaffold a tiny Node ESM CLI in src/cli.ts that prints the current time, " +
      "add a package.json with a `start` script, and verify the file contents.",
  },
  {
    id: "fix",
    label: "Fix & test",
    task:
      "Create src/math.ts with an `add(a, b)` function that intentionally returns " +
      "a+b+1, then fix it to return a+b and write a short note in NOTES.md explaining the bug.",
  },
] as const;

interface Config {
  hasApiKey: boolean;
  model: string;
  maxSteps: number;
}

type StatusFilter = "all" | "active" | "completed" | "failed";

export default function HomePage() {
  const router = useRouter();
  const [task, setTask] = useState(TEMPLATES[0].task);
  const [model, setModel] = useState("");
  const [config, setConfig] = useState<Config | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [activeTemplate, setActiveTemplate] = useState<string>(TEMPLATES[0].id);

  useEffect(() => {
    let alive = true;

    void fetch("/api/config")
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
      const data = (await res.json()) as {
        id?: string;
        message?: string;
        error?: string;
      };
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

  const stats = useMemo(() => {
    const active = runs.filter(
      (run) => run.status === "running" || run.status === "queued",
    ).length;
    const completed = runs.filter((run) => run.status === "completed").length;
    const failed = runs.filter(
      (run) => run.status === "failed" || run.status === "cancelled",
    ).length;
    return { total: runs.length, active, completed, failed };
  }, [runs]);

  const filtered = useMemo(() => {
    switch (filter) {
      case "active":
        return runs.filter(
          (run) =>
            run.status === "running" ||
            run.status === "queued" ||
            run.status === "waiting_input",
        );
      case "completed":
        return runs.filter((run) => run.status === "completed");
      case "failed":
        return runs.filter(
          (run) => run.status === "failed" || run.status === "cancelled",
        );
      default:
        return runs;
    }
  }, [runs, filter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Launch sandboxed agent runs and monitor every tool call live.
            {config
              ? ` Defaults: ${config.model} · ${config.maxSteps} steps.`
              : ""}
          </p>
        </div>
        {stats.active > 0 ? (
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 text-amber-300"
          >
            <span className="size-1.5 animate-pulse rounded-full bg-current" />
            {stats.active} live
          </Badge>
        ) : null}
      </div>

      {config && !config.hasApiKey ? (
        <Alert className="border-amber-500/30 bg-amber-500/10 text-amber-100">
          <AlertTriangle className="text-amber-300" />
          <AlertTitle className="text-amber-100">No API key configured</AlertTitle>
          <AlertDescription className="text-amber-100/80">
            Copy <code className="font-mono">.env.example</code> to{" "}
            <code className="font-mono">.env.local</code>, set{" "}
            <code className="font-mono">OPENAI_API_KEY</code>, and restart the
            dev server.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total runs"
          value={stats.total}
          icon={<CircleDashed className="size-4 text-muted-foreground" />}
        />
        <StatCard
          label="Active"
          value={stats.active}
          icon={<Loader2 className="size-4 text-amber-300" />}
          accent="text-amber-300"
        />
        <StatCard
          label="Completed"
          value={stats.completed}
          icon={<CheckCircle2 className="size-4 text-emerald-400" />}
          accent="text-emerald-400"
        />
        <StatCard
          label="Failed"
          value={stats.failed}
          icon={<XCircle className="size-4 text-red-400" />}
          accent="text-red-400"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3" size="sm">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Sparkles className="size-4 text-muted-foreground" />
              New run
            </CardTitle>
            <CardDescription>
              Describe a coding task. The agent gets an isolated workspace and
              streams append-only events.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4 pt-1">
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((template) => (
                  <Button
                    key={template.id}
                    type="button"
                    size="sm"
                    variant={
                      activeTemplate === template.id ? "secondary" : "outline"
                    }
                    onClick={() => {
                      setActiveTemplate(template.id);
                      setTask(template.task);
                    }}
                  >
                    {template.label}
                  </Button>
                ))}
              </div>

              <Textarea
                value={task}
                onChange={(e) => {
                  setTask(e.target.value);
                  setActiveTemplate("");
                }}
                rows={6}
                placeholder="Describe the file read/write task…"
                className="min-h-32 resize-y font-mono text-[13px]"
              />

              <div className="flex flex-wrap items-center gap-3">
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={
                    config ? `model (${config.model})` : "model override"
                  }
                  className="max-w-xs font-mono"
                />
                <Button
                  type="submit"
                  disabled={submitting || task.trim().length === 0}
                  className="gap-1.5"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {submitting ? "Starting…" : "Run agent"}
                </Button>
              </div>

              {error ? (
                <p className="text-sm text-red-400">{error}</p>
              ) : null}
            </form>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2" size="sm">
          <CardHeader className="border-b">
            <CardTitle>How it works</CardTitle>
            <CardDescription>
              Agent loop stays outside the sandbox; tools write into a per-run
              workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-1 text-sm text-muted-foreground">
            <Step n={1} text="Task is queued and a scratch workspace is created." />
            <Step n={2} text="The model streams thoughts, tool calls, and results." />
            <Step n={3} text="Workspace files update live as the agent writes." />
            <Step n={4} text="Run ends when the agent finishes or you stop it." />
          </CardContent>
          <CardFooter className="justify-between text-xs text-muted-foreground">
            <span>SSE event stream</span>
            <span className="font-mono">/api/runs/:id/stream</span>
          </CardFooter>
        </Card>
      </div>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Runs</h2>
            <span className="font-mono text-xs text-muted-foreground">
              {filtered.length}
              {filter !== "all" ? ` / ${runs.length}` : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["completed", "Done"],
                ["failed", "Failed"],
              ] as const
            ).map(([id, label]) => (
              <Button
                key={id}
                type="button"
                size="xs"
                variant={filter === id ? "secondary" : "ghost"}
                onClick={() => setFilter(id)}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <Card size="sm">
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              {runs.length === 0
                ? "No runs yet. Launch one above to open the agent cockpit."
                : "No runs match this filter."}
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card/40">
            <ul className="divide-y divide-border">
              {filtered.map((run) => (
                <li key={run.id}>
                  <Link
                    href={`/runs/${run.id}`}
                    className="group flex items-center gap-3 px-4 py-3 transition hover:bg-muted/40"
                  >
                    <StatusBadge status={run.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground/90">
                        {run.task}
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                        {run.model} · {run.eventCount} events · {run.id.slice(0, 8)}
                      </p>
                    </div>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                      {formatAgo(run.createdAt)}
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: number;
  icon: ReactNode;
  accent?: string;
}) {
  return (
    <Card size="sm" className="gap-2">
      <CardContent className="flex items-center justify-between pt-1">
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className={cn("mt-1 text-2xl font-semibold tabular-nums", accent)}>
            {value}
          </p>
        </div>
        <div className="flex size-9 items-center justify-center rounded-lg bg-muted/60">
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted font-mono text-[10px] text-muted-foreground">
        {n}
      </span>
      <p>{text}</p>
    </div>
  );
}
