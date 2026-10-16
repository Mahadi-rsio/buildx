# Plan — Cloud Dev AI Agent

An autonomous coding agent (like Jules / Devin / Copilot agent) that takes a task, spins up an isolated cloud workspace, writes code, runs it, fixes errors, and delivers a working result (preview URL + git branch/PR).

## 1. Vision

> Give it a task in plain language. It plans, codes, runs, tests, debugs, and ships — inside its own sandbox, while you watch from a dashboard.

## 2. Goals

- Agent can build a full app from scratch (Next.js, Node, Python, etc.), not just edit snippets.
- Every task runs in an **isolated Fly Machine** (microVM) with a real shell, filesystem, and network.
- **Strong search harness**: the agent finds the right code fast in big repos.
- Live dashboard: stream of thoughts, tool calls, terminal output, file diffs, preview.
- Human can interrupt, approve, or steer at any time.
- Output = git branch / PR + live preview URL.

## 3. Non-Goals (v1)

- Multi-agent swarms (single agent + optional subagent for search only).
- Custom model training / fine-tuning.
- IDE plugin (web dashboard only).
- Team/org billing (single-user first).

## 4. Tech Stack

| Layer | Choice |
|---|---|
| Frontend + API | Next.js (App Router), TypeScript |
| UI | shadcn/ui, Tailwind |
| State | Zustand (client), TanStack Query (server cache, optional) |
| Validation | Zod (tool schemas, API, env) |
| Auth | Better Auth |
| DB | Neon Postgres + Drizzle ORM |
| Agent loop | Vercel AI SDK 6 (`ToolLoopAgent`, typed tools, `stopWhen`, `prepareStep`) |
| Sandbox | **Fly Machines** (Machines REST API) behind a `Sandbox` interface — chosen over Fly Sprites for cost |
| Models | Provider-agnostic via AI SDK (Claude / GPT / Gemini / open models) |
| Search | ripgrep + tree-sitter repo map + optional embeddings |
| Streaming | SSE (AI SDK UI stream protocol) + WebSocket/SSE for terminal |

## 5. Core Concepts

- **Project** — a repo the agent works on (GitHub URL or empty).
- **Task** — one instruction ("add Stripe checkout") → one agent run.
- **Workspace** — one Fly Machine + volume holding the repo and tools.
- **Run** — the agent loop execution; produces messages, tool calls, events.
- **Harness** — the tools + prompts + context management around the model. This is where quality is won.

## 6. Phases

### Phase 0 — Foundation (week 1)
Next.js app, auth, DB schema, env/zod config, dashboard shell, basic chat UI.

### Phase 1 — Sandbox (week 1–2)
Define the `Sandbox` interface (exec, fs, background processes, snapshot/restore, preview URL). Implement `FlyMachinesSandbox`: create, start, stop, suspend, destroy. Base Docker image (Node, pnpm, git, ripgrep, python, build tools). Sandbox daemon (`exec`, files, ports). Volume per workspace + volume snapshots for rollback.

### Phase 2 — Agent loop MVP (week 2–3)
AI SDK 6 `ToolLoopAgent` with core tools: `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`. Raise the default step cap (20) for long coding tasks. Stream to UI. Persist messages + tool calls. Stop/resume.

### Phase 3 — Search harness (week 3–4)
`grep`, `glob`, repo map (tree-sitter), symbol search, optional semantic search. Context compaction. `AGENTS.md` support.

### Phase 4 — Dev experience (week 4–5)
Live terminal, file tree + diff viewer, preview iframe (dev server exposed via Fly proxy), git branch + commit + PR (GitHub App).

### Phase 5 — Reliability (week 5–6)
Planning/todo tool, self-verification (run build/tests/lint before "done"), error recovery, step/cost limits, approvals for risky commands, snapshots.

### Phase 6 — Polish & launch (week 6+)
Usage tracking, quotas, secrets manager, templates, onboarding, docs.

### Phase 7 — Fly workspace lifecycle: create/restore/archive
**Done** — `packages/sandbox` fly-manager (`createWorkspace`, `ensureRunning`,
`archive`, `reconcile`), daemon HTTP client (health/init/sync), storage-backed
backups with a strict sync → verify → rotate → destroy order, quotas + usage
sessions. Detailed spec + tests in `phase.md` §143–166. Root checks green.

## 7. Key Design Decisions

1. **Fly Machines, not Sprites (cost).** Sprites are persistent and have built-in checkpoint/restore, but cost too much for this product. Machines are cheaper; we rebuild the useful parts ourselves: suspend/stop on idle, volume snapshots for rollback, small machine sizes. Sandbox access goes through a `Sandbox` interface so the backend can be swapped later (Sprites, Vercel Sandbox, own Firecracker on Hetzner) without touching the harness.
2. **Agent loop lives outside the sandbox.** The orchestrator (Next.js server/worker) calls the model; tools execute remotely in the Fly Machine through a small daemon. Model keys never enter the sandbox.
3. **One Fly Machine per workspace**, suspend when idle (fast resume, cheap).
4. **Everything is an event.** Each message/tool call/terminal chunk is an append-only event row → replayable, resumable UI.
5. **Search before read.** Agent is trained (via prompt + tool design) to search → narrow → read ranges, never dump whole files.
6. **Verification is mandatory.** A task isn't done until build/test/lint pass or the agent explains why not.
7. **Least privilege.** Sandbox has no platform secrets; user secrets injected per workspace; network egress controllable.

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Runaway cost (tokens + machines) | Step limits, per-run budget, aggressive idle auto-stop/suspend, small machine sizes, volume cleanup for old workspaces, usage dashboard |
| Machines lack native checkpoint/restore | Volume snapshots before risky steps + git commits as checkpoints; restore = new volume from snapshot |
| Sandbox vendor lock-in | `Sandbox` interface with swappable adapters |
| Prompt injection from repo/web content | Treat tool output as untrusted, no secrets in sandbox, approval for destructive/network actions |
| Long runs exceed serverless limits | Run orchestrator on long-lived worker (own VPS/Fly app), durable events, resumable streams |
| Context overflow in big repos | Repo map, ranged reads, compaction, subagent for exploration |
| Flaky sandbox | Health checks, auto-restart, snapshot/restore |
| Agent loops/stalls | Loop detection, max steps, "ask user" escape hatch |

## 9. Success Metrics

- Task completion rate on a fixed eval set (e.g. 30 tasks: bugfix, feature, scaffold).
- Median time-to-first-preview.
- Avg cost per completed task.
- % of runs needing human intervention.
- Tool error rate.

## 10. Eval Strategy

Build a small benchmark early (Phase 2): 10–30 reproducible tasks ("scaffold todo app", "fix failing test in repo X", "add dark mode"). Run after every harness change. Track pass rate + cost.

## 11. Harness Build-vs-Buy Note

Default: build on AI SDK 6 `ToolLoopAgent` (matches the stack, full control over the Fly sandbox and event store). Once the eval set exists (Phase 2), benchmark Cline SDK (`@cline/sdk`) and OpenAI's open-sourced Codex Harness against our own loop; adopt one only if it wins on pass rate/cost and can run tools against a remote sandbox. DeepSeek's open-source harness is a reference for replay-driven testing and fail-closed sandboxing, not a dependency.
