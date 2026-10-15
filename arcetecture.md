# Architecture — Cloud Dev AI Agent

## 1. System Overview

```
┌──────────────────────────── Browser ─────────────────────────────┐
│ Next.js Dashboard (shadcn + Zustand)                              │
│ Chat • Plan/Todo • Terminal • File tree/Diff • Preview • Usage    │
└───────────────▲───────────────────────────┬──────────────────────┘
                │ SSE (AI stream + events)  │ REST / Server Actions
┌───────────────┴───────────────────────────▼──────────────────────┐
│ Orchestrator (Next.js API + Worker)                               │
│  • Better Auth        • Run manager (start/stop/resume)           │
│  • Agent loop (AI SDK 6 ToolLoopAgent + tools)                    │
│  • Context manager (compaction, repo map, AGENTS.md)              │
│  • Sandbox interface → FlyMachinesSandbox (Machines API + daemon) │
│  • Policy engine (approvals, budgets, limits)                     │
└───────┬─────────────────────────────┬────────────────────────────┘
        │ Drizzle                     │ HTTPS (Machines API / daemon)
┌───────▼────────┐          ┌─────────▼──────────────────────────┐
│ Neon Postgres  │          │ Fly Machines (1 per workspace)      │
│ users, runs,   │          │  ┌───────────────────────────────┐  │
│ events, ...    │          │  │ sandbox-daemon (HTTP/WS)      │  │
└────────────────┘          │  │ shell • fs • search • git     │  │
                            │  │ dev server ports → preview    │  │
                            │  └───────────────────────────────┘  │
                            │  Fly Volume: /workspace             │
                            └─────────────────────────────────────┘
```

## 2. Components

### 2.1 Dashboard (Next.js + shadcn + Zustand)
- **Chat panel** — streams assistant text, tool calls (collapsible), approvals.
- **Plan/Todo panel** — live view of the agent's todo list.
- **Terminal** — xterm.js fed by terminal events (read-only; optional interactive later).
- **Files** — tree + Monaco diff viewer of changed files.
- **Preview** — iframe to the workspace's dev-server URL.
- **Usage** — tokens, cost, machine time.
- Zustand stores: `useRunStore` (messages/events), `useWorkspaceStore` (status, files), `useUIStore` (panels).

### 2.2 Orchestrator
Hosts the agent loop. Must support **long runs (minutes–hours)**, so avoid short serverless limits: run it on a long-lived Node process (your own VPS / a Fly app) or a durable job runner. API routes enqueue/attach; the worker executes.

Responsibilities:
- Create/resume Run, load history from DB.
- Build system prompt + context (repo map, AGENTS.md, todo state).
- Run the `ToolLoopAgent` with tools; persist every step as events.
- Enforce limits (max steps, token/cost budget, wall time).
- Pause for human approval; resume on response.
- Manage workspace lifecycle (start, suspend, destroy).

### 2.3 Sandbox (Fly Machine)
- Custom Docker image: Ubuntu/Debian, Node + pnpm + bun, Python, git, ripgrep, fd, tree-sitter CLI, build-essential, GitHub CLI.
- **sandbox-daemon** (small Node/Go server, token-authenticated):
  - `POST /exec` — run command (stream stdout/stderr, timeout, cwd, env)
  - `POST /bg` / `GET /bg/:id` — background processes (dev servers), logs, kill
  - `GET/PUT /fs/*` — read (ranged), write, edit, list, stat, delete
  - `POST /search/grep`, `/search/glob`, `/search/symbols`
  - `POST /git/*` — status, diff, commit, branch, push
  - `GET /ports` — detected listening ports
- Volume mounted at `/workspace` (persists across suspend/restart).
- Idle → **suspend** (memory snapshot, fast resume) or stop; this is the main lever for keeping Machines cheap.
- Preview: expose dev-server port through Fly proxy; map `workspace-id` → URL (per-workspace Fly app, or a router app using `fly-force-instance-id`/replay).

### 2.4 Sandbox Interface + Fly Machines Adapter

**Decision: Fly Machines, not Fly Sprites.** Sprites bring persistence and native checkpoint/restore, but they are too costly for this product. Machines are cheaper, so we recreate the needed behavior ourselves and keep everything behind an interface so the backend can change later.

```ts
interface Sandbox {
  id: string;
  start(): Promise<void>;
  suspend(): Promise<void>;            // idle → cheap
  destroy(): Promise<void>;
  exec(cmd: string, opts?: ExecOpts): AsyncIterable<ExecChunk>;
  readFile(path: string, range?: Range): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  startBackground(cmd: string): Promise<ProcId>;
  checkpoint(label: string): Promise<CheckpointId>;   // volume snapshot + git commit
  restore(id: CheckpointId): Promise<void>;           // new volume from snapshot
  previewUrl(port: number): Promise<string>;
}
```

`FlyMachinesSandbox` is a thin typed wrapper over the Machines REST API (zod-validated): `createMachine`, `startMachine`, `stopMachine`, `suspendMachine`, `waitForState`, `destroyMachine`, `createVolume`, `snapshotVolume`, `restoreVolume`. It handles retries, idempotency, and rate limits. Other adapters (Sprites, Vercel Sandbox, self-hosted Firecracker on Hetzner) can be added later with no harness changes.

**Cost controls**
- Smallest machine size that runs the stack; upgrade per task only when needed.
- Auto-suspend/stop on idle (daemon reports last activity; worker enforces the timeout).
- Cap concurrent running workspaces per user.
- Delete volumes/snapshots of abandoned workspaces after a retention window.
- Track `machine_seconds` in `usage_ledger` and show it in the dashboard.

**Checkpoint/restore (our own, since Machines have no built-in one)**
- Before risky steps and at task milestones: git commit on a scratch branch + volume snapshot.
- Restore = create a new volume from the snapshot, attach, restart machine.

## 3. The Harness (where quality comes from)

### 3.1 Tools exposed to the model (zod schemas)

| Tool | Purpose |
|---|---|
| `bash` | Run shell command (timeout, cwd). Output truncated smartly (head+tail). |
| `bash_background` / `bash_logs` / `bash_kill` | Dev servers, watchers |
| `read_file` | Ranged read (`offset`, `limit`) with line numbers |
| `write_file` | Create/overwrite file |
| `edit_file` | Exact `old_str → new_str` replace (unique match required); multi-edit variant |
| `list_dir` | Tree with depth + ignore rules |
| `grep` | ripgrep, regex, globs, context lines, count/files modes |
| `glob` | Find files by pattern |
| `repo_map` | Ranked outline of repo: files → symbols (tree-sitter) |
| `find_symbol` | Definition/references lookup |
| `semantic_search` | Embedding search over code chunks (optional, Phase 3+) |
| `web_search` / `fetch_url` | Docs and library lookup |
| `todo_write` | Maintain visible task list (plan tracking) |
| `ask_user` | Clarifying question / approval request |
| `git_*` | status, diff, commit, branch, push, open PR |
| `preview_url` | Get/refresh preview link |
| `task_subagent` | Spawn read-only exploration subagent (own `ToolLoopAgent`, cheap model, own context) |
| `checkpoint` / `restore` | Volume snapshot + git commit rollback points |

### 3.2 Search strategy ("better harness")
1. **Repo map first**: tree-sitter extracts symbols per file; rank by PageRank-style import/reference graph (Aider-style). Inject a compact map (token-budgeted) into context.
2. **Grep-first exploration**: ripgrep is the workhorse; fast, exact, no index drift.
3. **Symbol index**: ctags/tree-sitter for definitions/references.
4. **Semantic search (optional)**: chunk by symbol, embed (e.g. small embedding model), store in pgvector (Neon) per workspace; incremental re-index on file change. Used for fuzzy "where is auth handled?" queries.
5. **Exploration subagent**: for broad questions, a cheap model searches in isolated context and returns a short summary + file:line refs → keeps main context clean.
6. **Ranged reads only**: tool descriptions + prompt push the model to read 50–200 line windows after locating via search.

### 3.3 Context management
- Token budget per step; track usage.
- **Compaction**: when context > ~70%, summarize old turns (decisions, files touched, open issues) and keep recent turns verbatim.
- **Tool output truncation** with "N more lines — use grep/read to narrow".
- **Pinned context**: AGENTS.md / project rules, current todo list, repo map.
- **Prompt caching** for the stable prefix (system + tool defs + repo map).

### 3.4 Agent loop (AI SDK)

```ts
import { ToolLoopAgent, stepCountIs } from "ai";

const agent = new ToolLoopAgent({
  model,
  instructions: buildSystemPrompt(ctx),
  tools: buildTools(sandbox, policy),      // zod-typed, backed by Sandbox interface
  // default cap is 20 steps — raise it for coding tasks
  stopWhen: [stepCountIs(MAX_STEPS), budgetExceeded, userAborted],
  prepareStep: ({ stepNumber, messages }) => compactIfNeeded(messages),
  onStepFinish: persistStep,               // events → Postgres
});

const result = await agent.stream({ messages, abortSignal });
```

`ToolLoopAgent` handles the loop, context management and stopping conditions; we own the execution environment (the `Sandbox`), persistence, policy and compaction. Exact option names should be checked against the installed AI SDK 6 version.

Loop rules in system prompt: plan with `todo_write` → search → edit → run → verify → fix → summarize. Must verify (build/test/lint) before finishing.

### 3.5 Safety & policy
- Command classification: safe (auto) / risky (approval) / blocked (e.g. `rm -rf /`, cloud metadata access).
- Network egress allowlist option per workspace.
- Secrets injected as env only into the sandbox, redacted in logs/events.
- Tool output treated as untrusted data (prompt-injection guard in system prompt).
- Per-user quotas: concurrent workspaces, machine-hours, tokens.

## 4. Data Model (Drizzle / Neon)

Better Auth manages: `user`, `session`, `account`, `verification`.

```
projects
  id, user_id → user, name, repo_url, default_branch, github_installation_id,
  created_at

workspaces
  id, project_id, fly_app, fly_machine_id, fly_volume_id, region,
  status (creating|running|suspended|stopped|error), size,
  image_version, preview_url, last_active_at, created_at

tasks
  id, project_id, workspace_id, title, prompt, status
  (queued|running|waiting_input|completed|failed|cancelled),
  branch, pr_url, created_at, finished_at

runs
  id, task_id, model, status, step_count, input_tokens, output_tokens,
  cost_usd, started_at, ended_at, error

messages
  id, run_id, role, parts (jsonb — AI SDK UIMessage parts), seq, created_at

events                       -- append-only, powers replay + live stream
  id (bigserial), run_id, type
  (text|tool_call|tool_result|terminal|file_change|todo|approval|status|error),
  payload jsonb, created_at

todos
  id, run_id, content, status (pending|in_progress|done), position

approvals
  id, run_id, tool_call_id, command, status (pending|approved|denied), decided_at

secrets
  id, project_id, key, value_encrypted, created_at

checkpoints
  id, workspace_id, run_id, label, fly_snapshot_id, git_commit, created_at

code_chunks (optional, pgvector)
  id, workspace_id, path, symbol, start_line, end_line, content, embedding vector, hash

usage_ledger
  id, user_id, run_id, kind (tokens|machine_seconds), amount, cost_usd, created_at
```

Indexes: `events(run_id, id)`, `messages(run_id, seq)`, `workspaces(project_id)`, `tasks(project_id, status)`.

## 5. Key Flows

### 5.1 Start a task
1. User submits prompt → `tasks` + `runs` rows created.
2. Orchestrator ensures workspace: create machine + volume (first time) or resume suspended one.
3. Clone repo (or scaffold) into `/workspace`; build repo map.
4. Agent loop starts; events stream to DB and to browser via SSE.
5. On finish: run verification, commit to branch, push, open PR, set preview URL, mark task completed.
6. Workspace suspends after idle timeout.

### 5.2 Streaming to the UI
- Browser opens `GET /api/runs/:id/stream?after=<eventId>`.
- Server tails `events` (LISTEN/NOTIFY or polling) → SSE.
- Reconnect-safe: client resumes from last event id. Page refresh never loses state.

### 5.3 Human approval
Agent calls risky tool → policy returns `needs_approval` → event + `approvals` row → run status `waiting_input` → user clicks approve/deny → run resumes.

### 5.4 Interrupt / steer
User sends message mid-run → queued; injected at next step boundary. Stop button → abort signal → graceful kill of running processes.

## 6. API Surface (Next.js route handlers, zod-validated)

```
POST   /api/projects
GET    /api/projects/:id
POST   /api/projects/:id/tasks          → create task + run
GET    /api/runs/:id/stream             → SSE
POST   /api/runs/:id/message            → steer
POST   /api/runs/:id/stop
POST   /api/approvals/:id               → approve | deny
GET    /api/workspaces/:id/files?path=
GET    /api/workspaces/:id/diff
POST   /api/workspaces/:id/suspend | resume | destroy
GET    /api/usage
```

## 7. Suggested Repo Structure

```
/apps/web                 Next.js dashboard + API
  /app                    routes (dashboard, projects, runs)
  /components             shadcn UI, chat, terminal, diff
  /stores                 zustand
/packages/agent           harness: prompts, tools, loop, compaction
/packages/sandbox         Fly client + daemon RPC client
/packages/db              drizzle schema + migrations
/packages/shared          zod schemas, types, env
/services/sandbox-daemon  runs inside Fly image
/services/worker          long-running orchestrator (if split from web)
/infra/fly-image          Dockerfile for sandbox
/evals                    benchmark tasks + runner
```

## 8. Deployment

- **Web + worker**: your own infra (Hetzner VPS / Cloudisy) or Fly app — long-lived Node process for the agent loop.
- **Neon**: main DB (branching for dev/staging).
- **Fly**: separate org/app for sandboxes (Machines, not Sprites); scoped Machines API token (orchestrator only).
- **Observability**: structured logs, OpenTelemetry via AI SDK telemetry, run replay from `events`, error tracking.

## 9. Security Summary

- Sandbox = Firecracker microVM, no platform credentials inside.
- Daemon authenticated by per-workspace token; reachable only from orchestrator (private network / signed requests).
- Model keys and Fly token stay in orchestrator.
- Secrets encrypted at rest (AES-GCM), decrypted only at injection.
- Rate limits + quotas; audit log via `events`.

## 10. Harness Alternatives (benchmark later)

Default is our own loop on AI SDK 6 `ToolLoopAgent`. After the Phase 2 eval set exists, benchmark Cline SDK (`@cline/sdk`) and OpenAI's open-source Codex Harness against it. Adopt one only if it wins on pass rate and cost and can run its tools against a remote sandbox through the `Sandbox` interface. DeepSeek's open-source harness is a reference for replay-driven testing and fail-closed sandboxing.
