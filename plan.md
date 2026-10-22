# Plan — Cloud Dev AI Agent

An autonomous coding agent (like Jules / Devin / Copilot agent) that takes a task, spins up an isolated cloud workspace, writes code, runs it, fixes errors, and delivers a working result (preview URL + git branch/PR).

## 1. Vision

> Give it a task in plain language. It plans, codes, runs, tests, debugs, and ships — inside its own sandbox, while you watch from a dashboard.

## 2. Goals

- Agent can build a full app from scratch (Next.js, Node, Python, etc.), not just edit snippets.
- Every task runs in an **isolated Upstash Box** microVM with a real shell, filesystem, and network.
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
| Agent loop | AI SDK 7 (`ToolLoopAgent`, typed tools, `stopWhen`, `prepareStep`) |
| Sandbox | **Upstash Box** (microVM, isolated per run) behind a `Sandbox` interface — chosen over Fly Machines for cost; Sprites / Vercel Sandbox / Firecracker later via adapter |
| Models | Provider-agnostic via AI SDK (Claude / GPT / Gemini / open models) |
| Search | ripgrep + tree-sitter repo map + optional embeddings |
| Streaming | SSE (AI SDK UI stream protocol) + WebSocket/SSE for terminal |
| Storage | S3-compatible (Cloudflare R2 production; MinIO local dev) |

## 5. Core Concepts

- **Project** — a repo the agent works on (GitHub URL or empty).
- **Task** — one instruction ("add Stripe checkout") → one agent run.
- **Workspace** — one Upstash Box microVM + volume holding the repo and tools.
- **Run** — the agent loop execution; produces messages, tool calls, events.
- **Harness** — the tools + prompts + context management around the model. This is where quality is won.

## 6. Phases

### Phase 0 — Foundation (week 1)

Next.js app, auth, DB schema, env/zod config, dashboard shell, basic chat UI.

### Phase 1 — Dockerized infra + storage (week 1–2)

- `docker-compose.yml` at repo root: `postgres` (official pin, e.g. `postgres:17-alpine`, `pg_isready` healthcheck, port `127.0.0.1` only) and `minio` (image from `MINIO_IMAGE`, default `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`, pinned tag, `server /data --console-address ":9001"`, ports `127.0.0.1:9000` / `127.0.0.1:9001`, root creds from env). Named volumes + healthchecks for both. Credentials never hardcoded.
- `.env.example`: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SMTP_*`, `MINIO_IMAGE`, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE=true`, `S3_BUCKET_WORKSPACES`, `S3_BUCKET_DB_BACKUPS`, `FLY_API_TOKEN`, `FLY_ORG_SLUG`. Real `.env` never committed (`.env` already gitignored).
- `scripts/init-storage.ts` (TypeScript, `@aws-sdk/client-s3`): idempotent CreateBucket for `buildx-workspaces` and `buildx-db-backups`. No `mc` client dependency.
- Drizzle wired to Postgres via `pg`/postgres.js with a connection pool; singleton `Pool` on `globalThis` in Next.js dev (hot-reload safe). `packages/db` becomes the only schema/queries home.
- Package scripts: `infra:up` (`docker compose up -d --wait`), `infra:down`, `db:generate`, `db:migrate`, `db:studio`, `storage:init`.
- Onboarding path works on a fresh clone: copy `.env.example` -> `pnpm install` -> `pnpm infra:up` -> `pnpm db:migrate` -> `pnpm storage:init`.
- Exit: typecheck + tests green; app boots against real Postgres + MinIO.

### Phase 2 — Better Auth + protected dashboard + requireUser (week 2–3)

- Better Auth wired to Drizzle (provider `"pg"`), same database. Generate auth tables with the Better Auth CLI and merge into the single `packages/db` schema so BuildX tables can FK to the auth user (match the id column type; do not assume).
- Login: email + password and GitHub OAuth. Email verification REQUIRED before workspace creation; in dev without SMTP, log the verification link to the server console.
- Mount auth route handler in Next.js. Helpers in `apps/web/lib/auth`: `getSession()` (server) and `requireUser()` (throws 401-style when unauthenticated). Every route/action touching projects, workspaces, runs, or sandboxes calls `requireUser()` + ownership check.
- Rate limiting on auth endpoints (verify option name); secure cookies in production.
- `BETTER_AUTH_SECRET`: strong random, required at startup (fail fast if missing).
- Pages: sign-in, sign-up, verify-email notice, protected dashboard layout (redirect unauthenticated to sign-in). Minimal shadcn UI.
- Exit: typecheck + tests green; unauthenticated requests to workspace/sandbox routes rejected; unverified user cannot create a workspace.

### Phase 3 — Core BuildX schema, transitions + quota functions (week 3–4)

- Drizzle tables per `arcetecture.md` §4, plus: `workspaces`, `usage_sessions`, `daily_requests`.
  - `workspaces`: id, user_id, name, status, daemon_token_encrypted, last_active_at, last_synced_at, backup_bytes, backup_sha256, lockfile_hash, image_digest, created_at, updated_at. `UNIQUE(user_id)` (one workspace per user).
  - Conventions: uuid PKs, created_at/updated_at timestamptz, FK to auth user, indexes on user_id and status.
- `db.transition(id, from, to)` -> boolean (single conditional UPDATE).
- Quota functions:
  - Monthly CPU-hours = closed `usage_sessions` + elapsed time of any open session (refuse restore when used up).
  - Daily counter: one atomic `INSERT ... ON CONFLICT (user_id, day) DO UPDATE SET count = count + 1 WHERE count < 30 RETURNING count`. Day boundary midnight Asia/Dhaka. Refund on server-side failure.
  - Per-request limits: max 25 steps, max 10 min, one active run per user.
  - Idle constant `FREE_IDLE_MINUTES = 5`.
- Test: daily counter never exceeds 30 under 100 concurrent requests.
- Exit: typecheck + tests green; migrations in place.

### Phase 4 — Daemon hardening + tests (`services/sandbox-daemon/server.mjs`) (week 4–5)

- Fail closed if auth token missing (refuse start / reject every request).
- Per-workspace token via `POST /init` (only endpoint accepted before init), compared in constant time.
- Add `GET /health`, `POST /init` (token + restoreUrl: download + extract into /workspace), `POST /sync` (uploadUrl: create tar.zst archive, upload, return `{size, sha256}`), last-activity tracking.
- Per-command timeout, max output size, process-tree cleanup on timeout/cancel, path validation (nothing outside /workspace readable/writable).
- Archive format: tar.zst of /workspace excluding `node_modules`, `.next`, `.turbo`, `dist`, `.cache`, `.pnpm-store`, `.env*`. Hard cap 200 MB per backup (configurable), reject larger with clear user error.
- Update `infra/fly-image/Dockerfile`: Node, pnpm, git, zstd, tar, curl, pre-warmed pnpm store (next, react, tailwind). Pin image by digest in config.
- Tests: token required; path escapes blocked.
- Exit: typecheck + tests green.

### Phase 5 — Lazy sandbox + web wiring (week 5–6)

- `lazy-sandbox.ts`: a `Sandbox` implementation calling `ensureRunning` on first use, then delegating to `DaemonSandbox` with this workspace's URL + token. Normal chat starts NO machine; machine created lazily on the first tool call needing the sandbox (exec, read/write/edit file).
- Replace global SANDBOX_BASE_URL/TOKEN in `apps/web/lib/sandbox.ts` with a per-workspace resolver; keep local mode for dev/tests.
- Per-workspace daemon token stored encrypted; presigned URLs short-lived.
- Exit: typecheck + tests green; local mode still works for dev/tests.

### Phase 6 — Reaper, reconciler, cleanup, pg_dump backup job (week 6+)

Background jobs, idempotent, each guarded with `pg_advisory_lock` (only one instance runs each):
- **Idle reaper (every minute):** archive workspaces idle >= FREE_IDLE_MINUTES AND no active agent run AND no running exec. Long builds must not be killed mid-run.
- **Reconciler (hourly):** diff Upstash Box machines/volumes/apps vs DB; destroy orphans; close stale usage sessions; retry archive_failed; fail rows stuck in creating/restoring > 10 min.
- **Storage cleanup (daily):** delete tmp upload keys older than 24 h; retention — notify then delete backups of workspaces inactive 90 days.
- **DB backup (nightly):** `pg_dump` -> compressed -> `S3_BUCKET_DB_BACKUPS`, keep last 7 dumps. Documented restore procedure tested once. Document that Postgres + MinIO Docker volumes need host-level backups in prod.
- Test: crash-after-volume-create repaired by reconciler.
- Exit: typecheck + tests green.

### Phase 7 — UI + events (`apps/web`) (week 7–8)

- Stream workspace events: `workspace.restoring` (with sub-steps), `workspace.ready`, `workspace.archiving`, `workspace.archived`.
- Show: status badge, countdown to auto-pause while running, monthly CPU-hours used (x of 5h), daily requests used (x of 30) with Dhaka reset time, clear messages when quota exhausted ("Your work is saved").
- Copy friendly and short.
- Exit: typecheck + lint + tests green.

### Phase 8 — Docs updates (week 8–9)

- Update `arcetecture.md` / `plan.md` / `todo.md`: Upstash Box lifecycle; new schema/API surface; local Dockerized dev stack details.
- Runbook in `docs/`: run one real create -> restore -> edit file -> archive -> restore cycle on Upstash Box, including exposing `S3_PUBLIC_ENDPOINT` to Box via a tunnel; confirm the file survived (hash match).
- README: startup (`pnpm infra:up && pnpm db:migrate && pnpm storage:init`), MINIO_IMAGE swap note.
- Final report: what's done, full TODO(verify) list, deviations from this spec + reasons.

## 7. Acceptance checklist (final)

- Fresh clone: `pnpm infra:up && pnpm db:migrate && pnpm storage:init` succeeds and the app boots.
- Storage: presigned PUT->GET round-trip; presigned URL expires; URL for key A cannot read key B.
- Unauthenticated requests to workspace/sandbox routes rejected; user A cannot act on user B's workspace.
- Unverified email cannot create a workspace.
- Concurrent `ensureRunning` -> exactly one machine.
- archive never deletes anything on upload/verify failure.
- Crash after volume-create repaired by reconciler.
- Daily counter never exceeds 30 under 100 concurrent requests.
- Quota exhaustion mid-session triggers backup-then-stop.
- `pnpm typecheck`, `pnpm lint`, `pnpm test` all green; docs runaround cycle proven live.

## 8. Open questions / risks

- `skip_launch`, volume-delete-while-attached, API rate limits, app/IP request shapes — unverified Box fields.
- Better Auth CLI schema generation + exact option names (rate limiting).
- Separate public endpoint vs signed host — must test MinIO accepts URLs signed for the public host.
- Free-tier Upstash Box org on a single developer account may itself hit Box API rate limits during reconcile.